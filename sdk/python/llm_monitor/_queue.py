"""A bounded, thread-safe, drop-oldest queue of events with their sizes."""
from __future__ import annotations

import threading
from collections import deque
from typing import Any, Deque, List, Tuple


class Item(object):
    """One queued event: the sanitised event dict, its serialised size in bytes, when it was queued, and how often a
    send of a batch containing it failed with a server error (used to isolate a poison event)."""

    __slots__ = ("event", "size", "queued_at", "attempts")

    def __init__(self, event: Any, size: int, queued_at: float) -> None:
        self.event = event
        self.size = size
        self.queued_at = queued_at
        self.attempts = 0


class BoundedQueue(object):
    """FIFO with a hard size limit. When full, the OLDEST item is dropped to make room for the new one
    (recent events are worth more than old ones when the server is unreachable), and the drop is counted."""

    def __init__(self, maxsize: int) -> None:
        if maxsize < 1:
            raise ValueError("maxsize must be >= 1")
        self._maxsize = maxsize
        self._items: Deque[Item] = deque()
        self._lock = threading.Lock()
        self._dropped = 0

    def put(self, item: Item) -> bool:
        """Adds an item. Returns True if an older item had to be dropped."""
        with self._lock:
            dropped = False
            if len(self._items) >= self._maxsize:
                self._items.popleft()
                self._dropped += 1
                dropped = True
            self._items.append(item)
            return dropped

    def take_batch(self, max_events: int, max_bytes: int, now: float, max_age: float) -> Tuple[List[Item], int]:
        """Removes and returns (batch, expired_count), oldest first.

        * items queued longer than `max_age` seconds are discarded (counted in `expired_count`): the server refuses events
          older than 24 h anyway, and a stale event is worth little;
        * the batch holds at most `max_events` items and, unless a single item is bigger than `max_bytes`, at most
          `max_bytes` of serialised events (a batch always has at least one item when any is left)."""
        with self._lock:
            batch: List[Item] = []
            expired = 0
            total = 0
            while self._items and len(batch) < max_events:
                head = self._items[0]
                if now - head.queued_at > max_age:
                    self._items.popleft()
                    expired += 1
                    continue
                if batch and total + head.size > max_bytes:
                    break
                batch.append(self._items.popleft())
                total += head.size
            return batch, expired

    def requeue_front(self, items: List[Item]) -> int:
        """Puts a batch that could not be delivered back at the FRONT, keeping its order. If the queue has no room for all
        of it, the OLDEST of those items are dropped first. Returns how many were dropped."""
        with self._lock:
            space = self._maxsize - len(self._items)
            keep = items[len(items) - space:] if space < len(items) else items
            if space <= 0:
                keep = []
            dropped = len(items) - len(keep)
            self._dropped += dropped
            for it in reversed(keep):
                self._items.appendleft(it)
            return dropped

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)

    @property
    def dropped(self) -> int:
        with self._lock:
            return self._dropped

    @property
    def maxsize(self) -> int:
        return self._maxsize
