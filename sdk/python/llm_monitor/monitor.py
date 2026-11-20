"""The Monitor: a bounded in-memory queue, a background flush thread, a flush at exit. Never raises into the host app."""
from __future__ import annotations

import logging
import os
import threading
import time
import warnings
import weakref
from typing import Any, Dict, List, Optional

from ._config import ENV_API_KEY, USER_AGENT_PREFIX, Config, resolve_config
from ._events import build_event
from ._queue import BoundedQueue
from ._transport import HttpTransport, SendResult

__version__ = "0.1.0.dev0"

logger = logging.getLogger("llm_monitor")
logger.addHandler(logging.NullHandler())

_STAT_KEYS = (
    "events_tracked", "events_dropped_queue_full", "events_dropped_disabled", "events_dropped_closed",
    "events_sent", "events_duplicate", "events_rejected", "events_failed",
    "batches_sent", "batches_failed", "fields_dropped", "errors",
)


class _Core(object):
    """Everything that must NOT survive a fork: the queue, the locks, the thread and the counters.

    A forked child gets a brand-new core (`fresh()`), so it never shares the parent's queue and starts its own flush
    thread. The thread only references the core, never the Monitor, so a Monitor that is garbage collected can stop it.
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
        # Current flush interval; P2.7b will update it from the server's flush_hint_ms (clamped to the configured range).
        self.interval_ms = cfg.flush_interval_ms
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

    # ---- sending --------------------------------------------------------------------------------------------------
    def send_all(self, deadline: Optional[float]) -> bool:
        """Sends queued events in batches until the queue is empty or the deadline passes. True if the queue is empty."""
        timeout = -1 if deadline is None else max(0.0, deadline - time.monotonic())
        if not self.send_lock.acquire(timeout=timeout):
            return False
        try:
            while True:
                if deadline is not None and time.monotonic() >= deadline:
                    return len(self.queue) == 0
                batch = self.queue.take(self.cfg.batch_size)
                if not batch:
                    return True
                self.send_batch(batch)
        finally:
            self.send_lock.release()

    def send_batch(self, batch: List[Dict[str, Any]]) -> None:
        try:
            result = self.transport.send(batch)
        except Exception as err:
            result = SendResult(False, None, None, None, "error:" + type(err).__name__)
        with self.lock:
            if result.ok:
                body = result.body or {}
                accepted = body.get("accepted")
                rejected = body.get("rejected")
                duplicates = body.get("duplicates")
                n_rej = len(rejected) if isinstance(rejected, list) else 0
                n_dup = duplicates if isinstance(duplicates, int) and not isinstance(duplicates, bool) else 0
                n_acc = accepted if isinstance(accepted, int) and not isinstance(accepted, bool) else len(batch) - n_rej
                self.stats["batches_sent"] += 1
                self.stats["events_sent"] += max(0, n_acc - n_dup)
                self.stats["events_duplicate"] += n_dup
                self.stats["events_rejected"] += n_rej
                hint = body.get("flush_hint_ms")
                if isinstance(hint, (int, float)) and not isinstance(hint, bool):
                    self.stats["last_flush_hint_ms"] = hint
            else:
                # P2.7a: one attempt, then the batch is dropped and counted. P2.7b adds bounded retries.
                self.stats["batches_failed"] += 1
                self.stats["events_failed"] += len(batch)
                self.stats["last_error"] = result.error

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
        self.send_all(deadline)


def _run(core: _Core) -> None:
    """The flush thread: wake when a batch is full or the interval has passed, then send everything queued."""
    while True:
        with core.cond:
            deadline = time.monotonic() + core.interval_ms / 1000.0
            while not core.stopping:
                if len(core.queue) >= core.cfg.batch_size:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                core.cond.wait(remaining)
            if core.stopping:
                return
        try:
            core.send_all(None)
        except Exception:  # the thread must survive anything
            core.count("errors")


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
            transport = HttpTransport(cfg.ingest_url, cfg.api_key, cfg.timeout_s, "%s/%s" % (USER_AGENT_PREFIX, __version__))
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
            event, dropped = build_event(fields, capture_content=core.cfg.capture_content)
            core.queue.put(event)
            with core.lock:
                core.stats["events_tracked"] += 1
                if dropped:
                    core.stats["fields_dropped"] += dropped
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
            return core.send_all(time.monotonic() + max(0.0, float(timeout)))
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
        yet, default transport. (A custom transport is not carried over.) The settings include the API key."""
        return (_rebuild, (dict(self._settings),))

    # ---- test hooks -----------------------------------------------------------------------------------------------
    def _thread_alive(self) -> bool:
        return self._holder is not None and self._holder.get().thread_alive()

    def _thread_ident(self) -> Optional[int]:
        t = None if self._holder is None else self._holder.get().thread
        return None if t is None else t.ident

    def _queue_len(self) -> int:
        return 0 if self._holder is None else len(self._holder.get().queue)
