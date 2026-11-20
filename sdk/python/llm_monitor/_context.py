"""Trace and span context for the SDK (contextvars: follows threads started with copy_context and asyncio tasks).

    with span("agent run", kind="agent"):          # starts a new trace
        with span("search", kind="tool"):          # child of the agent span
            ...
        client.chat.completions.create(...)       # an instrumented LLM call becomes a child automatically

A span emits ONE event when it exits (start timestamp, latency, status; an exception becomes status="error" and is
re-raised). Nothing here raises into the host application; with no monitor (none passed, no default) a span is a no-op that
still carries ids, so nested code keeps a consistent trace.
"""
from __future__ import annotations

import contextvars
import functools
import inspect
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

_DEFAULT: Dict[str, Any] = {"monitor": None}


class _Frame(object):
    __slots__ = ("trace_id", "span_id", "thread_id")

    def __init__(self, trace_id: str, span_id: str, thread_id: Optional[str]) -> None:
        self.trace_id = trace_id
        self.span_id = span_id
        self.thread_id = thread_id


_CURRENT: "contextvars.ContextVar[Optional[_Frame]]" = contextvars.ContextVar("llm_monitor_span", default=None)


def set_default_monitor(monitor: Any) -> None:
    """The monitor used by spans, `observe` and instrumented clients that were not given one."""
    _DEFAULT["monitor"] = monitor


def get_default_monitor() -> Any:
    return _DEFAULT["monitor"]


def new_span_id() -> str:
    return uuid.uuid4().hex[:16]


def new_trace_id() -> str:
    return uuid.uuid4().hex


def current_ids() -> Dict[str, str]:
    """Ids for an event created right now: the current trace and thread, and the current span as its parent."""
    frame = _CURRENT.get()
    if frame is None:
        return {}
    out = {"trace_id": frame.trace_id, "parent_id": frame.span_id}
    if frame.thread_id:
        out["thread_id"] = frame.thread_id
    return out


def _error_text(exc: BaseException) -> str:
    try:
        msg = str(exc)
    except Exception:
        msg = ""
    return ("%s: %s" % (type(exc).__name__, msg)) if msg else type(exc).__name__


class Span(object):
    """Context manager (sync and async). `span.set(...)` adds fields to the event before it is sent."""

    def __init__(self, name: str, *, kind: str = "custom", monitor: Any = None, trace_id: Optional[str] = None,
                 thread_id: Optional[str] = None, tags: Optional[List[str]] = None, **fields: Any) -> None:
        self.name = name
        self.kind = kind
        self.fields: Dict[str, Any] = dict(fields)
        if tags:
            self.fields["tags"] = list(tags)
        self.span_id = new_span_id()
        self.trace_id: Optional[str] = trace_id
        self.thread_id = thread_id
        self.event_id: Optional[str] = None
        self._monitor = monitor
        self._force_root = False
        self._token: Optional["contextvars.Token[Optional[_Frame]]"] = None
        self._parent: Optional[_Frame] = None
        self._prev: Optional[_Frame] = None
        self._t0 = 0.0
        self._ts: Optional[datetime] = None

    def set(self, **fields: Any) -> "Span":
        self.fields.update(fields)
        return self

    def __enter__(self) -> "Span":
        try:
            self._prev = _CURRENT.get()
            self._parent = None if self._force_root else self._prev  # a root span has no parent
            if self._parent is not None:
                self.trace_id = self._parent.trace_id
                self.thread_id = self.thread_id or self._parent.thread_id
            elif self.trace_id is None:
                self.trace_id = new_trace_id()
            self._token = _CURRENT.set(_Frame(self.trace_id, self.span_id, self.thread_id))
            self._ts = datetime.now(timezone.utc)
            self._t0 = time.perf_counter()
        except Exception:
            pass
        return self

    def __exit__(self, exc_type: Any, exc: Optional[BaseException], tb: Any) -> bool:
        try:
            latency_ms = int(round((time.perf_counter() - self._t0) * 1000))
            self._restore()
            monitor = self._monitor or get_default_monitor()
            if monitor is not None and monitor.enabled:
                event: Dict[str, Any] = dict(self.fields)
                event.update(kind=self.kind, name=self.name, trace_id=self.trace_id, span_id=self.span_id, latency_ms=latency_ms, ts=self._ts)
                if self._parent is not None:
                    event["parent_id"] = self._parent.span_id
                if self.thread_id:
                    event["thread_id"] = self.thread_id
                if exc is not None:
                    event["status"] = "error"
                    event["error"] = _error_text(exc)
                self.event_id = monitor.track(**event)
        except Exception:
            pass
        return False  # never swallows the application's exception

    def _restore(self) -> None:
        if self._token is None:
            return
        try:
            _CURRENT.reset(self._token)
        except ValueError:  # exited in another context (e.g. a task boundary): fall back to the parent
            _CURRENT.set(self._prev)
        self._token = None

    async def __aenter__(self) -> "Span":
        return self.__enter__()

    async def __aexit__(self, exc_type: Any, exc: Optional[BaseException], tb: Any) -> bool:
        return self.__exit__(exc_type, exc, tb)


def span(name: str, *, kind: str = "custom", monitor: Any = None, **kwargs: Any) -> Span:
    return Span(name, kind=kind, monitor=monitor, **kwargs)


def trace(name: str, *, kind: str = "agent", monitor: Any = None, trace_id: Optional[str] = None,
          thread_id: Optional[str] = None, **kwargs: Any) -> Span:
    """A root span: always starts a NEW trace, even inside another span (use `span` for a child)."""
    s = Span(name, kind=kind, monitor=monitor, trace_id=trace_id or new_trace_id(), thread_id=thread_id, **kwargs)
    s._force_root = True
    return s


def observe(name: Optional[str] = None, *, kind: str = "tool", monitor: Any = None, hash_args: bool = True) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorator: every call of the function is a span (sync and async functions; a generator function is timed only until it
    returns the generator). With hash_args the call arguments are hashed (never stored); a value JSON cannot represent, such as
    `self`, simply leaves the hash out."""

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        label = (name or getattr(fn, "__qualname__", None) or getattr(fn, "__name__", "function"))[:200]

        def make(args: Any, kwargs: Any) -> Span:
            s = Span(label, kind=kind, monitor=monitor)
            if hash_args:
                s.fields["args"] = {"args": list(args), "kwargs": kwargs}
            return s

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def awrapper(*args: Any, **kwargs: Any) -> Any:
                with make(args, kwargs):
                    return await fn(*args, **kwargs)

            return awrapper

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with make(args, kwargs):
                return fn(*args, **kwargs)

        return wrapper

    return decorate
