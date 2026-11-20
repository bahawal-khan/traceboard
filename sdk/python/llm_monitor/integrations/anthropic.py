"""Anthropic instrumentation: `instrument_anthropic(client)` records `client.messages.create(...)` and `client.messages.stream(...)`.

    from anthropic import Anthropic
    from llm_monitor import Monitor
    from llm_monitor.integrations.anthropic import instrument_anthropic

    client = instrument_anthropic(Anthropic(), Monitor())

Works for Anthropic and AsyncAnthropic. TOKEN CONVENTION: the Anthropic API reports `input_tokens` EXCLUDING cached tokens, so the
event carries input_tokens = input + cache_read + cache_creation (the total prompt) and cached_tokens = cache_read, which is what
the server's cost model expects (cached is a subset of the total). Cache-WRITE tokens are billed at a higher rate by Anthropic;
the server prices them as ordinary input for now (docs/PHASES.md, carried forward), so cost is slightly under-stated for them.

Streaming: `create(stream=True)` is timed event by event (time to first token = the first non-empty text, thinking or tool-input
delta, or the start of a tool_use block). For the `messages.stream()` helper, tokens and the model are read from the helper's
final snapshot when the `with` block ends, and time to first token is recorded only when you iterate the stream object itself
(not `text_stream`). A stream you abandon is reported once with the tag `incomplete`.

Not instrumented (yet): `with_raw_response`, `client.beta.*`, `messages.batches`, and clients made by `with_options(...)`. Content
is captured only when the monitor was configured with capture_content=True. Nothing here raises into the host application.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from . import _common as c

_MARK = "_llm_monitor_original"
_USAGE_KEYS = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens")


class _AnthropicCall(c.Call):
    name = "messages"

    def __init__(self, *a: Any, **k: Any) -> None:
        self.u: Dict[str, int] = {}
        self.stop_reason: Any = None
        super().__init__(*a, **k)

    def prompt_of(self, kwargs: Dict[str, Any]) -> Any:
        messages = kwargs.get("messages")
        system = kwargs.get("system")
        if messages is None:
            return None
        return {"system": system, "messages": messages} if system else messages

    def merge_usage(self, usage: Any) -> None:
        for key in _USAGE_KEYS:
            v = c.as_int(c.get(usage, key))
            if v is not None:  # cumulative totals: a later value replaces an earlier one, an omitted one keeps it
                self.u[key] = v

    def tokens(self) -> Tuple[Optional[int], Optional[int], Optional[int]]:
        u = self.u
        if "input_tokens" in u:
            total = u["input_tokens"] + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
        else:
            total = None
        return total, u.get("output_tokens"), u.get("cache_read_input_tokens")

    def on_chunk(self, event: Any) -> None:
        try:
            kind = c.get(event, "type")
            if kind == "message_start":
                message = c.get(event, "message")
                model = c.get(message, "model")
                if isinstance(model, str) and model:
                    self.model = model
                self.merge_usage(c.get(message, "usage"))
            elif kind == "content_block_start":
                if c.get(c.get(event, "content_block"), "type") in ("tool_use", "server_tool_use"):
                    self.mark_first_token()
            elif kind == "content_block_delta":
                delta = c.get(event, "delta")
                dtype = c.get(delta, "type")
                piece = c.get(delta, {"text_delta": "text", "thinking_delta": "thinking", "input_json_delta": "partial_json"}.get(dtype, "text"))
                if isinstance(piece, str) and piece:
                    self.mark_first_token()
                    if dtype == "text_delta":
                        self.add_output(piece)
            elif kind == "text":  # the helper stream's own event, emitted after the raw delta: timing only
                if c.get(event, "text"):
                    self.mark_first_token()
            elif kind == "message_delta":
                self.merge_usage(c.get(event, "usage"))
                self.stop_reason = c.get(c.get(event, "delta"), "stop_reason") or self.stop_reason
        except Exception:
            pass

    def read_message(self, message: Any) -> None:
        """A complete (or snapshot) Message: model, usage, text blocks."""
        try:
            model = c.get(message, "model")
            if isinstance(model, str) and model:
                self.model = model
            self.merge_usage(c.get(message, "usage"))
            self.stop_reason = c.get(message, "stop_reason") or self.stop_reason
            if self.capture:
                texts = [c.get(b, "text") for b in (c.get(message, "content") or []) if c.get(b, "type") == "text"]
                texts = [t for t in texts if isinstance(t, str)]
                if texts:
                    self.output_text = "".join(texts)
        except Exception:
            pass

    on_response = read_message


def _no_prepare(kwargs: Dict[str, Any]) -> bool:
    return False  # Anthropic streams always carry usage: nothing to inject, nothing to hide


def _stream_call(monitor: Any, kwargs: Dict[str, Any], provider: str, stream: bool) -> c.Call:
    return _AnthropicCall(monitor, kwargs, provider, True)


class _HelperStream(object):
    """The object `with client.messages.stream(...) as s` yields: iteration is observed, everything else is delegated."""

    def __init__(self, inner: Any, call: _AnthropicCall) -> None:
        self._inner = inner
        self._call = call
        self._it: Any = None

    def __iter__(self) -> "_HelperStream":
        return self

    def __next__(self) -> Any:
        if self._it is None:
            self._it = iter(self._inner)
        event = next(self._it)  # errors propagate; the manager's __exit__ reports them
        self._call.on_chunk(event)
        return event

    def __aiter__(self) -> "_HelperStream":
        return self

    async def __anext__(self) -> Any:
        if self._it is None:
            self._it = self._inner.__aiter__()
        event = await self._it.__anext__()
        self._call.on_chunk(event)
        return event

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._inner, name)


class _Manager(object):
    """Wraps the object returned by `messages.stream(...)` (a sync or async context manager)."""

    def __init__(self, inner: Any, call: _AnthropicCall) -> None:
        self._inner = inner
        self._call = call
        self._stream: Any = None

    def _report(self, exc: Any) -> None:
        try:
            snapshot = None
            try:
                snapshot = getattr(self._stream, "current_message_snapshot", None)
            except Exception:
                snapshot = None  # raised when no message_start has arrived
            if snapshot is not None:
                self._call.read_message(snapshot)
        except Exception:
            pass
        self._call.finish(error=exc if isinstance(exc, BaseException) else None, incomplete=exc is None and self._call.stop_reason is None)

    def __enter__(self) -> Any:
        try:
            self._stream = self._inner.__enter__()
        except BaseException as err:
            self._call.finish(error=err)
            raise
        return _HelperStream(self._stream, self._call)

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> Any:
        self._report(exc)
        return self._inner.__exit__(exc_type, exc, tb)

    async def __aenter__(self) -> Any:
        try:
            self._stream = await self._inner.__aenter__()
        except BaseException as err:
            self._call.finish(error=err)
            raise
        return _HelperStream(self._stream, self._call)

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> Any:
        self._report(exc)
        return await self._inner.__aexit__(exc_type, exc, tb)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._inner, name)


def _wrap_stream_helper(orig: Any, monitor_arg: Any, provider: str) -> Any:
    def stream(*args: Any, **kwargs: Any) -> Any:
        begun = c.begin(monitor_arg, kwargs, provider, _stream_call, _no_prepare)
        if begun is None:
            return orig(*args, **kwargs)
        call = begun[0]
        try:
            manager = orig(*args, **kwargs)
        except BaseException as err:
            call.finish(error=err)
            raise
        return _Manager(manager, call)

    return stream


def instrument_anthropic(client: Any, monitor: Any = None, *, provider: str = "anthropic") -> Any:
    """Patches `client.messages.create` and `client.messages.stream` in place and returns the client. Idempotent. `monitor`
    defaults to the one set with `set_default_monitor`, looked up on every call. Raises TypeError if `client.messages.create`
    does not exist."""

    def make_create(orig: Any, is_async: bool) -> Any:
        return (c.wrap_async if is_async else c.wrap_sync)(orig, monitor, provider, _AnthropicCall, _no_prepare)

    c.patch(client.messages, "create", _MARK, make_create, client)
    if getattr(client.messages, "stream", None) is not None:
        c.patch(client.messages, "stream", _MARK, lambda orig, is_async: _wrap_stream_helper(orig, monitor, provider), client)
    return client


def uninstrument_anthropic(client: Any) -> Any:
    c.unpatch(client.messages, "create", _MARK)
    c.unpatch(client.messages, "stream", _MARK)
    return client
