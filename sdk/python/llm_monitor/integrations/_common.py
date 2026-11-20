"""Shared machinery for provider integrations: the per-call recorder, stream proxies and call wrappers.

A provider module supplies a `_Call` subclass that knows how to read ITS usage and chunks; everything else (idempotent
reporting, abandoned streams, errors, passthrough when the monitor is disabled) lives here and is tested once."""
from __future__ import annotations

import inspect
import json
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from .._context import current_ids, get_default_monitor, new_span_id, _error_text

CAPTURE_CHARS = 8_192


def get(obj: Any, key: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def as_int(v: Any) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def messages_text(messages: Any) -> str:
    try:
        return json.dumps(messages, ensure_ascii=False, default=str)[: CAPTURE_CHARS * 4]
    except Exception:
        return ""


class Call(object):
    """State of ONE API call. `finish` is idempotent: whichever of end-of-stream, close, error or garbage collection comes
    first sends the event, and later ones do nothing. Subclasses implement the provider-specific parts."""

    name = "llm"

    def __init__(self, monitor: Any, kwargs: Dict[str, Any], provider: str, stream: bool) -> None:
        self.monitor = monitor
        self.provider = provider
        self.stream = stream
        self.model: Optional[str] = kwargs.get("model") if isinstance(kwargs.get("model"), str) else None
        self.ts = datetime.now(timezone.utc)
        self.t0 = time.perf_counter()
        self.ttft_ms: Optional[int] = None
        self.completed = False
        self._done = False
        self._lock = threading.Lock()
        self.ids = current_ids()
        self.span_id = new_span_id() if self.ids else None
        self.prompt: Any = self.prompt_of(kwargs)
        self.input_text: Optional[str] = None
        self.capture = bool(monitor.captures_content)
        if self.capture and self.prompt is not None:
            self.input_text = messages_text(self.prompt)
        self.output_parts: List[str] = []
        self.output_chars = 0
        self.output_text: Optional[str] = None

    # ---- provider hooks ------------------------------------------------------------------------------------------------
    def prompt_of(self, kwargs: Dict[str, Any]) -> Any:
        return kwargs.get("messages")

    def tokens(self) -> Tuple[Optional[int], Optional[int], Optional[int]]:
        """(input TOTAL, output, cached subset of the input)."""
        return None, None, None

    def on_chunk(self, chunk: Any) -> None:
        pass

    def hides(self, chunk: Any) -> bool:
        return False

    def on_response(self, resp: Any) -> None:
        pass

    # ---- helpers for subclasses ----------------------------------------------------------------------------------------
    def mark_first_token(self) -> None:
        if self.ttft_ms is None:
            self.ttft_ms = int(round((time.perf_counter() - self.t0) * 1000))

    def add_output(self, text: Any) -> None:
        if self.capture and isinstance(text, str) and self.output_chars < CAPTURE_CHARS:
            self.output_parts.append(text)
            self.output_chars += len(text)

    def finish(self, error: Optional[BaseException] = None, incomplete: bool = False) -> None:
        with self._lock:
            if self._done:
                return
            self._done = True
        try:
            latency_ms = int(round((time.perf_counter() - self.t0) * 1000))
            tin, tout, tcached = self.tokens()
            fields: Dict[str, Any] = {
                "kind": "llm", "name": self.name, "provider": self.provider, "ts": self.ts, "latency_ms": latency_ms,
                "input_tokens": tin, "output_tokens": tout, "cached_tokens": tcached,
            }
            if self.model:
                fields["model"] = self.model
            if self.ttft_ms is not None:
                fields["ttft_ms"] = self.ttft_ms
            fields.update(self.ids)
            if self.span_id:
                fields["span_id"] = self.span_id
            tags = []
            if self.stream:
                tags.append("stream")
            if incomplete:
                tags.append("incomplete")
            if tags:
                fields["tags"] = tags
            if self.prompt is not None:
                fields["prompt"] = self.prompt
            if self.capture:
                out = self.output_text if self.output_text is not None else "".join(self.output_parts)
                content: Dict[str, str] = {}
                if self.input_text:
                    content["input"] = self.input_text
                if out:
                    content["output"] = out
                if content:
                    fields["content"] = content
            if error is not None:
                fields["status"] = "error"
                fields["error"] = _error_text(error)
            self.monitor.track(**fields)
        except Exception:
            pass

class SyncStream(object):
    def __init__(self, inner: Any, call: Call, hide_usage: bool) -> None:
        self._inner = inner
        self._call = call
        self._hide = hide_usage
        self._it: Any = None

    def __iter__(self) -> "SyncStream":
        return self

    def __next__(self) -> Any:
        if self._it is None:
            self._it = iter(self._inner)
        while True:
            try:
                chunk = next(self._it)
            except StopIteration:
                self._call.finish()
                raise
            except BaseException as err:
                self._call.finish(error=err)
                raise
            self._call.on_chunk(chunk)
            if self._hide and self._call.hides(chunk):
                continue
            return chunk

    def close(self) -> None:
        self._call.finish(incomplete=True)
        close = getattr(self._inner, "close", None)
        if close is not None:
            close()

    def __enter__(self) -> "SyncStream":
        enter = getattr(self._inner, "__enter__", None)
        if enter is not None:
            enter()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> Any:
        if exc is not None:
            self._call.finish(error=exc)
        else:
            self._call.finish(incomplete=True)
        ex = getattr(self._inner, "__exit__", None)
        return ex(exc_type, exc, tb) if ex is not None else None

    def __del__(self) -> None:
        try:
            self._call.finish(incomplete=True)
        except Exception:
            pass

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._inner, name)


class AsyncStream(object):
    def __init__(self, inner: Any, call: Call, hide_usage: bool) -> None:
        self._inner = inner
        self._call = call
        self._hide = hide_usage
        self._it: Any = None

    def __aiter__(self) -> "AsyncStream":
        return self

    async def __anext__(self) -> Any:
        if self._it is None:
            self._it = self._inner.__aiter__()
        while True:
            try:
                chunk = await self._it.__anext__()
            except StopAsyncIteration:
                self._call.finish()
                raise
            except BaseException as err:
                self._call.finish(error=err)
                raise
            self._call.on_chunk(chunk)
            if self._hide and self._call.hides(chunk):
                continue
            return chunk

    async def close(self) -> None:
        self._call.finish(incomplete=True)
        close = getattr(self._inner, "close", None)
        if close is not None:
            res = close()
            if inspect.isawaitable(res):
                await res

    async def __aenter__(self) -> "AsyncStream":
        enter = getattr(self._inner, "__aenter__", None)
        if enter is not None:
            await enter()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> Any:
        if exc is not None:
            self._call.finish(error=exc)
        else:
            self._call.finish(incomplete=True)
        ex = getattr(self._inner, "__aexit__", None)
        return (await ex(exc_type, exc, tb)) if ex is not None else None

    def __del__(self) -> None:
        try:
            self._call.finish(incomplete=True)
        except Exception:
            pass

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._inner, name)


def begin(monitor_arg: Any, kwargs: Dict[str, Any], provider: str, factory: Callable[..., Call], prepare: Callable[[Dict[str, Any]], bool]) -> Any:
    """Returns (call, hide_usage) or None when the call should pass through untouched."""
    try:
        monitor = monitor_arg or get_default_monitor()
        if monitor is None or not monitor.enabled:
            return None
        stream = bool(kwargs.get("stream"))
        hide = prepare(kwargs)
        return factory(monitor, kwargs, provider, stream), hide
    except Exception:
        return None


def wrap_sync(orig: Callable[..., Any], monitor_arg: Any, provider: str, factory: Callable[..., Call], prepare: Callable[[Dict[str, Any]], bool]) -> Callable[..., Any]:
    def create(*args: Any, **kwargs: Any) -> Any:
        begun = begin(monitor_arg, kwargs, provider, factory, prepare)
        if begun is None:
            return orig(*args, **kwargs)
        call, hide = begun
        try:
            result = orig(*args, **kwargs)
        except BaseException as err:
            call.finish(error=err)
            raise
        if call.stream:
            return SyncStream(result, call, hide)
        call.on_response(result)
        call.finish()
        return result

    return create


def wrap_async(orig: Callable[..., Any], monitor_arg: Any, provider: str, factory: Callable[..., Call], prepare: Callable[[Dict[str, Any]], bool]) -> Callable[..., Any]:
    async def create(*args: Any, **kwargs: Any) -> Any:
        begun = begin(monitor_arg, kwargs, provider, factory, prepare)
        if begun is None:
            return await orig(*args, **kwargs)
        call, hide = begun
        try:
            result = await orig(*args, **kwargs)
        except BaseException as err:
            call.finish(error=err)
            raise
        if call.stream:
            return AsyncStream(result, call, hide)
        call.on_response(result)
        call.finish()
        return result

    return create


def patch(owner: Any, attr: str, mark: str, make: Callable[[Callable[..., Any], bool], Callable[..., Any]], client: Any) -> bool:
    """Replaces owner.<attr> by make(original, is_async). False when it was already patched."""
    orig = getattr(owner, attr, None)
    if orig is None:
        raise TypeError("cannot instrument: %s not found" % attr)
    if hasattr(orig, mark):
        return False
    is_async = inspect.iscoroutinefunction(orig) or type(client).__name__.startswith("Async")
    wrapped = make(orig, is_async)
    setattr(wrapped, mark, orig)
    setattr(owner, attr, wrapped)
    return True


def unpatch(owner: Any, attr: str, mark: str) -> None:
    orig = getattr(getattr(owner, attr, None), mark, None)
    if orig is not None:
        setattr(owner, attr, orig)
