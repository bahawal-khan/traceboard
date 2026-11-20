"""OpenAI instrumentation: `instrument_openai(client)` records every `client.chat.completions.create(...)` call.

    from openai import OpenAI
    from llm_monitor import Monitor
    from llm_monitor.integrations.openai import instrument_openai

    client = instrument_openai(OpenAI(), Monitor())

Works for OpenAI and AsyncOpenAI, with and without `stream=True`. Per call it records the model (the one the API reports),
input/output/cached tokens, latency, time to first token (streams: the first chunk that carries content, a tool call or a
refusal, not the role-only chunk), status and error, a hash of the messages, and the current trace/span as parent. Content text
is captured only when the monitor was configured with capture_content=True.

Streams: if the caller did not set `stream_options`, `{"include_usage": true}` is injected so token counts exist, and the extra
final usage-only chunk (empty `choices`) is hidden from the caller, who asked for no such chunk. If the caller set
`stream_options` themselves, nothing is changed and the usage chunk is passed through as they requested.

Not instrumented (yet): `with_raw_response` / `with_streaming_response`, `client.responses`, `client.beta.*`, and clients made
by `client.with_options(...)` (call `instrument_openai` on those too). The wrapper never raises into the host application;
instrumentation failures are swallowed and counted.
"""
from __future__ import annotations

import inspect
import json
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from .._context import current_ids, get_default_monitor, new_span_id, _error_text

_MARK = "_llm_monitor_original"
_CAPTURE_CHARS = 8_192


def _get(obj: Any, key: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _int(v: Any) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


class _Call(object):
    """State of ONE API call. `finish` is idempotent: whichever of end-of-stream, close, error or garbage collection comes
    first sends the event, and later ones do nothing."""

    def __init__(self, monitor: Any, kwargs: Dict[str, Any], provider: str, stream: bool) -> None:
        self.monitor = monitor
        self.provider = provider
        self.stream = stream
        self.model: Optional[str] = kwargs.get("model") if isinstance(kwargs.get("model"), str) else None
        self.ts = datetime.now(timezone.utc)
        self.t0 = time.perf_counter()
        self.ttft_ms: Optional[int] = None
        self.usage: Any = None
        self.completed = False
        self._done = False
        self._lock = threading.Lock()
        self.ids = current_ids()
        self.span_id = new_span_id() if self.ids else None
        self.messages = kwargs.get("messages")
        self.capture = bool(monitor.captures_content)
        self.output_parts: List[str] = []
        self.output_chars = 0
        self.output_text: Optional[str] = None

    # -- streaming input ---------------------------------------------------------------------------------------------
    def on_chunk(self, chunk: Any) -> None:
        try:
            model = _get(chunk, "model")
            if isinstance(model, str) and model:
                self.model = model
            usage = _get(chunk, "usage")
            if usage is not None:
                self.usage = usage
            for choice in _get(chunk, "choices") or []:
                delta = _get(choice, "delta")
                text = _get(delta, "content")
                if text or _get(delta, "tool_calls") or _get(delta, "refusal") or _get(delta, "function_call"):
                    if self.ttft_ms is None:
                        self.ttft_ms = int(round((time.perf_counter() - self.t0) * 1000))
                if self.capture and isinstance(text, str) and self.output_chars < _CAPTURE_CHARS:
                    self.output_parts.append(text)
                    self.output_chars += len(text)
        except Exception:
            pass

    # -- non-streaming input -----------------------------------------------------------------------------------------
    def on_response(self, resp: Any) -> None:
        try:
            model = _get(resp, "model")
            if isinstance(model, str) and model:
                self.model = model
            self.usage = _get(resp, "usage")
            if self.capture:
                choices = _get(resp, "choices") or []
                text = _get(_get(choices[0], "message"), "content") if choices else None
                if isinstance(text, str):
                    self.output_text = text
        except Exception:
            pass

    def finish(self, error: Optional[BaseException] = None, incomplete: bool = False) -> None:
        with self._lock:
            if self._done:
                return
            self._done = True
        try:
            latency_ms = int(round((time.perf_counter() - self.t0) * 1000))
            usage = self.usage
            prompt_tokens = _int(_get(usage, "prompt_tokens"))
            fields: Dict[str, Any] = {
                "kind": "llm", "name": "chat.completions", "provider": self.provider, "ts": self.ts, "latency_ms": latency_ms,
                "input_tokens": prompt_tokens, "output_tokens": _int(_get(usage, "completion_tokens")),
                # OpenAI reports prompt_tokens as the TOTAL and cached_tokens as a subset of it: exactly the server's convention.
                "cached_tokens": _int(_get(_get(usage, "prompt_tokens_details"), "cached_tokens")),
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
            if self.messages is not None:
                fields["prompt"] = self.messages
            if self.capture:
                out = self.output_text if self.output_text is not None else "".join(self.output_parts)
                content: Dict[str, str] = {}
                if self.messages is not None:
                    content["input"] = _messages_text(self.messages)
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


def _messages_text(messages: Any) -> str:
    try:
        return json.dumps(messages, ensure_ascii=False, default=str)[: _CAPTURE_CHARS * 4]
    except Exception:
        return ""


def _prepare(kwargs: Dict[str, Any]) -> bool:
    """Injects stream usage when the caller left stream_options alone. Returns True when it did."""
    if kwargs.get("stream") and "stream_options" not in kwargs:
        kwargs["stream_options"] = {"include_usage": True}
        return True
    return False


def _is_hidden_usage_chunk(chunk: Any) -> bool:
    return _get(chunk, "usage") is not None and not (_get(chunk, "choices") or [])


class _SyncStream(object):
    def __init__(self, inner: Any, call: _Call, hide_usage: bool) -> None:
        self._inner = inner
        self._call = call
        self._hide = hide_usage
        self._it: Any = None

    def __iter__(self) -> "_SyncStream":
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
            if self._hide and _is_hidden_usage_chunk(chunk):
                continue
            return chunk

    def close(self) -> None:
        self._call.finish(incomplete=True)
        close = getattr(self._inner, "close", None)
        if close is not None:
            close()

    def __enter__(self) -> "_SyncStream":
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


class _AsyncStream(object):
    def __init__(self, inner: Any, call: _Call, hide_usage: bool) -> None:
        self._inner = inner
        self._call = call
        self._hide = hide_usage
        self._it: Any = None

    def __aiter__(self) -> "_AsyncStream":
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
            if self._hide and _is_hidden_usage_chunk(chunk):
                continue
            return chunk

    async def close(self) -> None:
        self._call.finish(incomplete=True)
        close = getattr(self._inner, "close", None)
        if close is not None:
            res = close()
            if inspect.isawaitable(res):
                await res

    async def __aenter__(self) -> "_AsyncStream":
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


def _begin(monitor_arg: Any, kwargs: Dict[str, Any], provider: str) -> Any:
    """Returns (monitor, call, hide_usage) or None when the call should pass through untouched."""
    try:
        monitor = monitor_arg or get_default_monitor()
        if monitor is None or not monitor.enabled:
            return None
        stream = bool(kwargs.get("stream"))
        hide = _prepare(kwargs)
        return _Call(monitor, kwargs, provider, stream), hide
    except Exception:
        return None


def _wrap_sync(orig: Callable[..., Any], monitor_arg: Any, provider: str) -> Callable[..., Any]:
    def create(*args: Any, **kwargs: Any) -> Any:
        begun = _begin(monitor_arg, kwargs, provider)
        if begun is None:
            return orig(*args, **kwargs)
        call, hide = begun
        try:
            result = orig(*args, **kwargs)
        except BaseException as err:
            call.finish(error=err)
            raise
        if call.stream:
            return _SyncStream(result, call, hide)
        call.on_response(result)
        call.finish()
        return result

    return create


def _wrap_async(orig: Callable[..., Any], monitor_arg: Any, provider: str) -> Callable[..., Any]:
    async def create(*args: Any, **kwargs: Any) -> Any:
        begun = _begin(monitor_arg, kwargs, provider)
        if begun is None:
            return await orig(*args, **kwargs)
        call, hide = begun
        try:
            result = await orig(*args, **kwargs)
        except BaseException as err:
            call.finish(error=err)
            raise
        if call.stream:
            return _AsyncStream(result, call, hide)
        call.on_response(result)
        call.finish()
        return result

    return create


def instrument_openai(client: Any, monitor: Any = None, *, provider: str = "openai") -> Any:
    """Patches `client.chat.completions.create` in place and returns the client. Idempotent. `monitor` defaults to the one set
    with `set_default_monitor`, looked up on every call. `provider` is the label stored with each event (set it for
    OpenAI-compatible servers, e.g. "azure" or "ollama"). Raises TypeError if `client` has no chat.completions.create."""
    target = client.chat.completions
    orig = getattr(target, "create", None)
    if orig is None:
        raise TypeError("instrument_openai: client.chat.completions.create not found")
    if hasattr(orig, _MARK):
        return client
    is_async = inspect.iscoroutinefunction(orig) or type(client).__name__.startswith("Async")
    wrapped = (_wrap_async if is_async else _wrap_sync)(orig, monitor, provider)
    setattr(wrapped, _MARK, orig)
    target.create = wrapped
    return client


def uninstrument_openai(client: Any) -> Any:
    target = client.chat.completions
    current = getattr(target, "create", None)
    orig = getattr(current, _MARK, None)
    if orig is not None:
        target.create = orig
    return client
