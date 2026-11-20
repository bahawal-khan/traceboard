"""The Monitor: a bounded in-memory queue, a background flush thread, a flush at exit. Never raises into the host app."""
from __future__ import annotations

import json
import logging
import os
import pickle
import random
import threading
import time
import warnings
import weakref
from typing import Any, Dict, List, Optional

from ._config import ENV_API_KEY, USER_AGENT_PREFIX, Config, resolve_config
from ._events import build_event
from ._queue import BoundedQueue, Item
from ._redact import make_redactor
from ._transport import HttpTransport, SendResult

__version__ = "0.1.0.dev0"

logger = logging.getLogger("llm_monitor")
logger.addHandler(logging.NullHandler())

_STAT_KEYS = (
    "events_tracked", "events_dropped_queue_full", "events_dropped_disabled", "events_dropped_closed",
    "events_sent", "events_duplicate", "events_rejected", "events_failed",
    "batches_sent", "batches_failed", "batches_requeued", "events_expired", "fields_dropped", "redaction_errors", "errors",
)

# A 5xx other than these is treated as possibly caused by one poison event (the others mean "unavailable").
_UNAVAILABLE = (502, 503, 504)
_MAX_POISON_ATTEMPTS = 5
_AUTH_STATUSES = (401, 403)


class _Core(object):
    """Everything that must NOT survive a fork: the queue, the locks, the thread and the counters.

    A forked child gets a brand-new core (`fresh()`), so it never shares the parent's queue and starts its own flush
    thread. The thread only references the core, never the Monitor, so a Monitor that is garbage collected can stop it.

    Delivery model (P2.7b): a batch that could not be delivered for a TRANSIENT reason (network error, timeout, 408, 429,
    5xx) goes back to the FRONT of the bounded queue and is retried after an exponential backoff with jitter, never
    earlier than a (capped) Retry-After. Nothing waits inside a retry loop, so `track()` and `shutdown()` stay prompt.
    A batch that failed for a PERMANENT reason (other 4xx, 3xx) is dropped and counted: resending it cannot succeed.
    Memory is bounded by the queue size; staleness is bounded by `max_event_age_s`.
    """

    def __init__(self, cfg: Config, transport: Any) -> None:
        self.cfg = cfg
        self.transport = transport
        self.pid = os.getpid()
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.send_lock = threading.Lock()
        self.queue = BoundedQueue(cfg.queue_size)
        self.thread: Optional[threading.Thread] = None
        self.stopping = False
        self.closed = False
        # Current flush interval: starts at the configured value and follows the server's flush_hint_ms, clamped to
        # [min_flush_interval_ms, max_flush_interval_ms].
        self.interval_ms = cfg.flush_interval_ms
        self.last_flush = time.monotonic()
        # Retry state. `retry_at` is a time.monotonic() value: nothing is sent by the background thread before it.
        self.retry_at = 0.0
        self.consecutive_failures = 0
        # Adaptive batch size: halved when the server refuses a batch as too large or fails on it (isolating a poison
        # event), doubled back towards batch_size after successes.
        self.batch_cap = cfg.batch_size
        self.rand = random.random
        # Local redaction of captured content AND of the free-text `error` field: the user's redactor first, then the built-in
        # rules. Content only exists with capture_content; `error` is always sent, so its redaction does not depend on capture.
        # (redact_content=False turns the built-in rules off for both; a custom redactor then still applies.)
        self.redactor = make_redactor(cfg.redactor, cfg.redact_content)
        self.stats: Dict[str, Any] = dict((k, 0) for k in _STAT_KEYS)
        self.stats["last_error"] = None
        self.stats["last_flush_hint_ms"] = None

    def fresh(self) -> "_Core":
        core = _Core(self.cfg, self.transport)
        core.closed = self.closed
        return core

    # ---- counters -------------------------------------------------------------------------------------------------
    def count(self, key: str, n: int = 1) -> None:
        with self.lock:
            self.stats[key] += n

    # ---- thread ---------------------------------------------------------------------------------------------------
    def ensure_thread(self) -> None:
        t = self.thread
        if t is not None and t.is_alive():
            return
        with self.lock:
            if self.closed or self.stopping:
                return
            if self.thread is not None and self.thread.is_alive():
                return
            self.last_flush = time.monotonic()  # the first event waits one full interval, so events are batched
            thread = threading.Thread(target=_run, args=(self,), name="llm-monitor-flush", daemon=True)
            try:
                thread.start()
            except RuntimeError:  # e.g. the interpreter is shutting down: cannot start threads any more
                self.stats["errors"] += 1
                return
            self.thread = thread

    def thread_alive(self) -> bool:
        t = self.thread
        return t is not None and t.is_alive()

    # ---- backoff --------------------------------------------------------------------------------------------------
    def backoff_delay(self, failures: int, retry_after: Optional[float], retry_after_cap: Optional[float] = None) -> float:
        """Seconds to wait before the next attempt after `failures` consecutive failures: exponential, capped, with "equal
        jitter" (half fixed, half random) so many SDKs recovering from one outage do not return in lockstep, and never
        shorter than the server's Retry-After, itself capped at `retry_after_cap` (default: max_retry_after_s)."""
        ceiling = min(self.cfg.retry_max_s, self.cfg.retry_base_s * (2 ** min(max(failures, 1) - 1, 30)))
        delay = ceiling / 2.0 + self.rand() * ceiling / 2.0
        if retry_after is not None and retry_after > 0:
            cap = self.cfg.max_retry_after_s if retry_after_cap is None else retry_after_cap
            delay = max(delay, min(retry_after, cap))
        return delay

    # ---- sending --------------------------------------------------------------------------------------------------
    def send_all(self, deadline: Optional[float], respect_gate: bool) -> bool:
        """Sends queued events in batches until the queue is empty, the deadline passes, or a send fails transiently
        (then it stops: no hammering a struggling server; the backoff gate decides when to try again).
        `respect_gate=False` is for an explicit flush() / shutdown(): one attempt now. True if the queue is empty."""
        timeout = -1 if deadline is None else max(0.0, deadline - time.monotonic())
        if not self.send_lock.acquire(timeout=timeout):
            return False
        try:
            while True:
                if deadline is not None and time.monotonic() >= deadline:
                    return len(self.queue) == 0
                if respect_gate and time.monotonic() < self.retry_at:
                    return len(self.queue) == 0
                outcome = self._send_once()
                if outcome == "empty":
                    return True
                if outcome == "retry":
                    return False
        finally:
            self.send_lock.release()

    def _send_once(self) -> str:
        """Takes one batch and tries to deliver it. Returns "empty", "ok", "dropped", "split" or "retry"."""
        batch, expired = self.queue.take_batch(self.batch_cap, self.cfg.max_batch_bytes, time.monotonic(), self.cfg.max_event_age_s)
        if expired:
            self.count("events_expired", expired)
        if not batch:
            return "empty"
        try:
            result = self.transport.send([it.event for it in batch])
        except Exception as err:
            result = SendResult(False, None, None, None, "error:" + type(err).__name__)
        if result.ok:
            self._on_success(batch, result)
            return "ok"
        return self._on_failure(batch, result)

    def _on_success(self, batch: List[Item], result: SendResult) -> None:
        body = result.body or {}
        accepted = body.get("accepted")
        rejected = body.get("rejected")
        duplicates = body.get("duplicates")
        n_rej = len(rejected) if isinstance(rejected, list) else 0
        n_dup = duplicates if isinstance(duplicates, int) and not isinstance(duplicates, bool) else 0
        n_acc = accepted if isinstance(accepted, int) and not isinstance(accepted, bool) else len(batch) - n_rej
        hint = body.get("flush_hint_ms")
        with self.cond:
            self.stats["batches_sent"] += 1
            self.stats["events_sent"] += max(0, n_acc - n_dup)
            self.stats["events_duplicate"] += n_dup
            self.stats["events_rejected"] += n_rej
            self.consecutive_failures = 0
            self.retry_at = 0.0
            self.batch_cap = min(self.cfg.batch_size, self.batch_cap * 2)
            if isinstance(hint, (int, float)) and not isinstance(hint, bool) and hint == hint and hint > 0:  # NaN, 0 and negatives are ignored
                self.stats["last_flush_hint_ms"] = hint
                self.interval_ms = max(self.cfg.min_flush_interval_ms, min(self.cfg.max_flush_interval_ms, float(hint)))
                self.cond.notify_all()  # the thread may be waiting on the old interval: let it recompute

    def _on_failure(self, batch: List[Item], result: SendResult) -> str:
        status = result.status
        permanent = status is not None and (300 <= status < 400 or (400 <= status < 500 and status not in (408, 429)))
        # ONLY a 429 whose body says quota_exceeded gets the larger Retry-After cap; a missing or malformed body, or any
        # other status or error code, keeps the normal cap.
        body = result.body
        quota = status == 429 and isinstance(body, dict) and body.get("error") == "quota_exceeded"
        with self.lock:
            self.stats["batches_failed"] += 1
            self.stats["last_error"] = "quota_exceeded" if quota else result.error

        if status == 413 and len(batch) > 1:
            # Too large for the server: halve and retry at once (this should not happen with byte-based splitting).
            self.batch_cap = max(1, len(batch) // 2)
            self.queue.requeue_front(batch)
            self.count("batches_requeued")
            return "split"
        if permanent:
            # Resending the same bytes cannot help: drop and count. Rejected credentials also pause sending for a while.
            self.count("events_failed", len(batch))
            if status in _AUTH_STATUSES:
                with self.lock:
                    self.retry_at = time.monotonic() + self.cfg.retry_max_s
                logger.warning("llm_monitor: the server refused the API key (HTTP %s); events are dropped until it is fixed", status)
            return "dropped"

        if status is not None and status >= 500 and status not in _UNAVAILABLE:
            # The server failed on THIS payload (a plain 500 is not "unavailable"): isolate a poison event by halving the
            # batch on every failure, and give up on a single event after a few attempts so it cannot block the queue.
            if len(batch) > 1:
                self.batch_cap = max(1, len(batch) // 2)
            else:
                batch[0].attempts += 1
                if batch[0].attempts >= _MAX_POISON_ATTEMPTS:
                    self.count("events_failed")
                    return "dropped"

        dropped = self.queue.requeue_front(batch)
        with self.lock:
            self.stats["batches_requeued"] += 1
            self.consecutive_failures += 1
            self.retry_at = time.monotonic() + self.backoff_delay(
                self.consecutive_failures, result.retry_after_s, self.cfg.max_quota_retry_after_s if quota else None
            )
        if dropped:
            logger.debug("llm_monitor: queue full while retrying, %d oldest events dropped", dropped)
        return "retry"

    def shutdown(self, timeout: float) -> None:
        deadline = time.monotonic() + max(0.0, timeout)
        with self.cond:
            if self.closed and self.stopping:
                return
            self.stopping = True
            self.closed = True
            self.cond.notify_all()
        t = self.thread
        if t is not None and t is not threading.current_thread() and t.is_alive():
            t.join(max(0.0, deadline - time.monotonic()))
        self.send_all(deadline, respect_gate=False)


def _run(core: _Core) -> None:
    """The flush thread: wake when a batch is full or the interval has passed, then send what is queued. It never sends
    before the retry gate opens (a failed send closes it for a backoff period), and it re-reads the interval on every
    wake-up, so a new flush_hint_ms takes effect immediately."""
    while True:
        with core.cond:
            while not core.stopping:
                now = time.monotonic()
                if len(core.queue) >= core.cfg.batch_size:
                    due = now  # a full batch goes at once...
                else:
                    due = core.last_flush + core.interval_ms / 1000.0
                due = max(due, core.retry_at)  # ...but never before the backoff allows
                remaining = due - now
                if remaining <= 0:
                    break
                core.cond.wait(remaining)
            if core.stopping:
                return
        try:
            core.send_all(None, respect_gate=True)
        except Exception:  # the thread must survive anything
            core.count("errors")
        core.last_flush = time.monotonic()


class _Holder(object):
    """Indirection so a fork can swap the core without the Monitor (or its finalizer) noticing."""

    __slots__ = ("core", "__weakref__")

    def __init__(self, core: _Core) -> None:
        self.core = core

    def get(self) -> _Core:
        core = self.core
        if core.pid != os.getpid():  # forked on a platform without register_at_fork, or before the hook ran
            core = self.core = core.fresh()
        return core


_HOLDERS: "weakref.WeakSet[_Holder]" = weakref.WeakSet()


def _after_fork_in_child() -> None:
    # No locks are touched: the child's copies of the parent's locks may be held by threads that do not exist here.
    for holder in list(_HOLDERS):
        holder.core = holder.core.fresh()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork_in_child)


def _finalize(holder: _Holder) -> None:
    """Runs when a Monitor is garbage collected AND at interpreter exit (weakref.finalize atexit=True)."""
    try:
        core = holder.get()
        if core.cfg is not None:
            core.shutdown(core.cfg.exit_flush_timeout_s)
    except Exception:
        pass


_announced = False


def _announce_disabled(reason: Optional[str]) -> None:
    """A silently disabled SDK is a nasty surprise, so say so once per process: a log line and a RuntimeWarning.
    Never raises (a warnings filter set to 'error' would otherwise turn the warning into an exception)."""
    global _announced
    logger.warning("llm_monitor is disabled: %s", reason)
    if _announced:
        return
    _announced = True
    try:
        warnings.warn("llm_monitor is disabled: %s" % reason, RuntimeWarning, stacklevel=4)
    except Exception:
        pass


def _rebuild(settings: Dict[str, Any]) -> "Monitor":
    return Monitor(**settings)


class Monitor(object):
    """Collects events and ships them to the platform in the background.

        mon = Monitor()                      # LLM_MONITOR_API_KEY / LLM_MONITOR_URL
        mon.track(kind="llm", model="gpt-4o", input_tokens=120, output_tokens=40, latency_ms=830)

    Nothing here raises into your application. A missing or invalid configuration disables the SDK (see `config_error`).
    """

    def __init__(self, api_key: Optional[str] = None, url: Optional[str] = None, *, transport: Any = None, **options: Any) -> None:
        self._settings: Dict[str, Any] = dict(options)
        self._settings["api_key"] = api_key
        self._settings["url"] = url
        self._lock = threading.Lock()
        self._local_stats: Dict[str, Any] = dict((k, 0) for k in _STAT_KEYS)
        self._local_stats["last_error"] = None
        self._local_stats["last_flush_hint_ms"] = None
        self._holder: Optional[_Holder] = None
        self._finalizer: Optional["weakref.finalize"] = None
        self.config_error: Optional[str] = None
        cfg: Optional[Config] = None
        try:
            cfg, self.config_error = resolve_config(api_key, url, **options)
        except Exception as err:  # a bad option type must not break the host app either
            self.config_error = "invalid options (%s)" % type(err).__name__
        if cfg is None:
            _announce_disabled(self.config_error)
            return
        if transport is None:
            transport = HttpTransport(cfg.ingest_url, cfg.api_key, cfg.timeout_s, "%s/%s" % (USER_AGENT_PREFIX, __version__), cfg.compress)
        self._holder = _Holder(_Core(cfg, transport))
        _HOLDERS.add(self._holder)
        self._finalizer = weakref.finalize(self, _finalize, self._holder)

    # ---- state ----------------------------------------------------------------------------------------------------
    @property
    def enabled(self) -> bool:
        return self._holder is not None

    @property
    def stats(self) -> Dict[str, Any]:
        """A snapshot of the counters. Always safe to call."""
        try:
            if self._holder is None:
                return dict(self._local_stats, queue_size=0, enabled=False)
            core = self._holder.get()
            with core.lock:
                snap = dict(core.stats)
            snap["consecutive_failures"] = core.consecutive_failures
            snap["interval_ms"] = core.interval_ms
            snap["batch_cap"] = core.batch_cap
            snap["queue_size"] = len(core.queue)
            snap["events_dropped_queue_full"] = core.queue.dropped
            snap["enabled"] = True
            return snap
        except Exception:
            return {"enabled": self.enabled, "errors": 1}

    def __repr__(self) -> str:  # never shows the key
        if self._holder is None:
            return "Monitor(enabled=False)"
        core = self._holder.core
        return "Monitor(enabled=True, url=%r, queued=%d)" % (core.cfg.base_url, len(core.queue))

    # ---- tracking -------------------------------------------------------------------------------------------------
    def track(self, **fields: Any) -> Optional[str]:
        """Queues one event and returns its event_id (None when disabled or closed). Never raises, never blocks on the network."""
        try:
            if self._holder is None:
                with self._lock:
                    self._local_stats["events_dropped_disabled"] += 1
                return None
            core = self._holder.get()
            if core.closed:
                core.count("events_dropped_closed")
                return None
            report: Dict[str, int] = {}
            event, dropped = build_event(
                fields, capture_content=core.cfg.capture_content, redactor=core.redactor, hash_salt=core.cfg.hash_salt, report=report
            )
            size = len(json.dumps(event, separators=(",", ":")))  # the serialised size, to split batches by bytes
            core.queue.put(Item(event, size, time.monotonic()))
            with core.lock:
                core.stats["events_tracked"] += 1
                if dropped:
                    core.stats["fields_dropped"] += dropped
                if report.get("redaction_errors"):
                    core.stats["redaction_errors"] += report["redaction_errors"]
            core.ensure_thread()
            if len(core.queue) >= core.cfg.batch_size:
                with core.cond:
                    core.cond.notify()
            return event["event_id"]
        except Exception:
            try:
                if self._holder is not None:
                    self._holder.get().count("errors")
            except Exception:
                pass
            return None

    # ---- flushing -------------------------------------------------------------------------------------------------
    def flush(self, timeout: float = 5.0) -> bool:
        """Sends everything queued, in the calling thread, waiting at most `timeout` seconds. True if the queue is empty."""
        try:
            if self._holder is None:
                return True
            core = self._holder.get()
            return core.send_all(time.monotonic() + max(0.0, float(timeout)), respect_gate=False)
        except Exception:
            return False

    def shutdown(self, timeout: Optional[float] = None) -> None:
        """Stops the background thread after a final flush. Later track() calls are ignored."""
        try:
            if self._holder is None:
                return
            core = self._holder.get()
            core.shutdown(core.cfg.exit_flush_timeout_s if timeout is None else float(timeout))
            if self._finalizer is not None:
                self._finalizer.detach()
        except Exception:
            pass

    close = shutdown

    def __enter__(self) -> "Monitor":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.shutdown()

    # ---- pickling (multiprocessing with spawn / forkserver) -------------------------------------------------------
    def __reduce__(self) -> Any:
        """A pickled Monitor arrives in the child as a FRESH Monitor with the same settings: empty queue, no thread
        yet, default transport. (A custom transport is not carried over.) The settings include the API key and the hash salt.

        A custom `redactor` MUST be picklable (a module-level function): if it is not, pickling FAILS LOUDLY instead of
        building a child Monitor that quietly redacts less than the parent does."""
        redactor = self._settings.get("redactor")
        if redactor is not None:
            try:
                pickle.dumps(redactor)
            except Exception as err:
                raise pickle.PicklingError(
                    "llm_monitor: the custom redactor cannot be pickled (%s); use a module-level function, "
                    "or start the child with the 'fork' start method" % type(err).__name__
                )
        return (_rebuild, (dict(self._settings),))

    # ---- test hooks -----------------------------------------------------------------------------------------------
    def _thread_alive(self) -> bool:
        return self._holder is not None and self._holder.get().thread_alive()

    def _thread_ident(self) -> Optional[int]:
        t = None if self._holder is None else self._holder.get().thread
        return None if t is None else t.ident

    def _queue_len(self) -> int:
        return 0 if self._holder is None else len(self._holder.get().queue)
