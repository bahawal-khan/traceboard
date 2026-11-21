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

Not instrumented (yet): `with_raw_response` / `with_streaming_response` (those calls pass through untouched and are not
recorded), `client.responses`, `client.beta.*`, and clients made by `client.with_options(...)` (call `instrument_openai` on those too). The wrapper never raises into the host application;
instrumentation failures are swallowed and counted.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from . import _common as c

_MARK = "_llm_monitor_original"


class _OpenAICall(c.Call):
    name = "chat.completions"

    def __init__(self, *a: Any, **k: Any) -> None:
        self.usage: Any = None
        super().__init__(*a, **k)

    def tokens(self) -> Tuple[Optional[int], Optional[int], Optional[int]]:
        u = self.usage
        # OpenAI reports prompt_tokens as the TOTAL and cached_tokens as a subset of it: exactly the server's convention.
        return (c.as_int(c.get(u, "prompt_tokens")), c.as_int(c.get(u, "completion_tokens")),
                c.as_int(c.get(c.get(u, "prompt_tokens_details"), "cached_tokens")))

    def on_chunk(self, chunk: Any) -> None:
        try:
            model = c.get(chunk, "model")
            if isinstance(model, str) and model:
                self.model = model
            usage = c.get(chunk, "usage")
            if usage is not None:
                self.usage = usage
            for choice in c.get(chunk, "choices") or []:
                delta = c.get(choice, "delta")
                text = c.get(delta, "content")
                if text or c.get(delta, "tool_calls") or c.get(delta, "refusal") or c.get(delta, "function_call"):
                    self.mark_first_token()
                self.add_output(text)
        except Exception:
            pass

    def hides(self, chunk: Any) -> bool:
        return c.get(chunk, "usage") is not None and not (c.get(chunk, "choices") or [])

    def on_response(self, resp: Any) -> None:
        try:
            model = c.get(resp, "model")
            if isinstance(model, str) and model:
                self.model = model
            self.usage = c.get(resp, "usage")
            if self.capture:
                choices = c.get(resp, "choices") or []
                text = c.get(c.get(choices[0], "message"), "content") if choices else None
                if isinstance(text, str):
                    self.output_text = text
        except Exception:
            pass


def _prepare(kwargs: Dict[str, Any]) -> bool:
    """Injects stream usage when the caller left stream_options alone. Returns True when it did."""
    if kwargs.get("stream") and "stream_options" not in kwargs:
        kwargs["stream_options"] = {"include_usage": True}
        return True
    return False


def instrument_openai(client: Any, monitor: Any = None, *, provider: str = "openai") -> Any:
    """Patches `client.chat.completions.create` in place and returns the client. Idempotent. `monitor` defaults to the one set
    with `set_default_monitor`, looked up on every call. `provider` is the label stored with each event (set it for
    OpenAI-compatible servers, e.g. "azure" or "ollama"). Raises TypeError if `client` has no chat.completions.create."""

    def make(orig: Any, is_async: bool) -> Any:
        return (c.wrap_async if is_async else c.wrap_sync)(orig, monitor, provider, _OpenAICall, _prepare)

    c.patch(client.chat.completions, "create", _MARK, make, client)
    return client


def uninstrument_openai(client: Any) -> Any:
    c.unpatch(client.chat.completions, "create", _MARK)
    return client
