"""A bounded, thread-safe, drop-oldest queue."""
from __future__ import annotations

import threading
from collections import deque
from typing import Any, Deque, List


class BoundedQueue(object):
    """FIFO with a hard size limit. When full, the OLDEST item is dropped to make room for the new one
    (recent events are worth more than old ones when the server is unreachable), and the drop is counted."""

    def __init__(self, maxsize: int) -> None:
        if maxsize < 1:
            raise ValueError("maxsize must be >= 1")
        self._maxsize = maxsize
        self._items: Deque[Any] = deque()
        self._lock = threading.Lock()
        self._dropped = 0

    def put(self, item: Any) -> bool:
        """Adds an item. Returns True if an older item had to be dropped."""
        with self._lock:
            dropped = False
            if len(self._items) >= self._maxsize:
                self._items.popleft()
                self._dropped += 1
                dropped = True
            self._items.append(item)
            return dropped

    def take(self, n: int) -> List[Any]:
        """Removes and returns up to n items, oldest first."""
        with self._lock:
            out: List[Any] = []
            while self._items and len(out) < n:
                out.append(self._items.popleft())
            return out

    def __len__(self) -> int:
        with self._lock:  # a lock-free len() is atomic too, but this keeps the invariant obvious
            return len(self._items)

    @property
    def dropped(self) -> int:
        with self._lock:
            return self._dropped

    @property
    def maxsize(self) -> int:
        return self._maxsize
