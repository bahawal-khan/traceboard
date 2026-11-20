"""Duck-typed stand-ins for the OpenAI client (the real package is not a dependency of the SDK or its tests)."""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace as NS
from typing import Any, Dict, List, Optional


def usage(prompt: int = 100, completion: int = 20, cached: Optional[int] = None) -> Any:
    details = NS(cached_tokens=cached) if cached is not None else None
    return NS(prompt_tokens=prompt, completion_tokens=completion, total_tokens=prompt + completion, prompt_tokens_details=details)


def response(text: str = "hi", model: str = "gpt-4o-2024-08-06", use: Any = None) -> Any:
    return NS(id="chatcmpl-1", model=model, usage=use if use is not None else usage(),
              choices=[NS(index=0, message=NS(role="assistant", content=text), finish_reason="stop")])


def chunk(text: Optional[str] = None, *, role: bool = False, tool: bool = False, use: Any = None, model: str = "gpt-4o-2024-08-06", empty: bool = False) -> Any:
    delta = NS(role="assistant" if role else None, content=text, tool_calls=[NS(index=0)] if tool else None, refusal=None, function_call=None)
    return NS(id="c", model=model, usage=use, choices=[] if empty else [NS(index=0, delta=delta, finish_reason=None)])


def script(texts: List[str], with_usage: bool = True, use: Any = None) -> List[Any]:
    """role-only chunk, content chunks, then (like OpenAI with include_usage) a usage-only chunk with empty choices."""
    out = [chunk(role=True)] + [chunk(t) for t in texts]
    if with_usage:
        out.append(chunk(empty=True, use=use if use is not None else usage()))
    return out


class FakeStream(object):
    def __init__(self, chunks: List[Any], delay: float = 0.0, fail_at: Optional[int] = None) -> None:
        self.chunks, self.delay, self.fail_at = chunks, delay, fail_at
        self.closed = False
        self.response = NS(status_code=200)

    def __iter__(self) -> Any:
        for i, c in enumerate(self.chunks):
            if self.fail_at == i:
                raise ConnectionError("stream dropped for bob@example.com")
            if self.delay:
                time.sleep(self.delay)
            yield c

    def close(self) -> None:
        self.closed = True

    def __enter__(self) -> "FakeStream":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class FakeAsyncStream(object):
    def __init__(self, chunks: List[Any], delay: float = 0.0, fail_at: Optional[int] = None) -> None:
        self.chunks, self.delay, self.fail_at = chunks, delay, fail_at
        self.closed = False

    def __aiter__(self) -> Any:
        return self._gen().__aiter__()

    async def _gen(self) -> Any:
        for i, c in enumerate(self.chunks):
            if self.fail_at == i:
                raise ConnectionError("stream dropped")
            if self.delay:
                await asyncio.sleep(self.delay)
            yield c

    async def close(self) -> None:
        self.closed = True

    async def __aenter__(self) -> "FakeAsyncStream":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()


class _Completions(object):
    def __init__(self, owner: Any) -> None:
        self.owner = owner

    def create(self, **kwargs: Any) -> Any:
        self.owner.calls.append(kwargs)
        if self.owner.raises:
            raise self.owner.raises
        if kwargs.get("stream"):
            return FakeStream(list(self.owner.chunks), self.owner.delay, self.owner.fail_at)
        if self.owner.delay:
            time.sleep(self.owner.delay)
        return self.owner.reply


class _AsyncCompletions(_Completions):
    async def create(self, **kwargs: Any) -> Any:  # type: ignore[override]
        self.owner.calls.append(kwargs)
        if self.owner.raises:
            raise self.owner.raises
        if kwargs.get("stream"):
            return FakeAsyncStream(list(self.owner.chunks), self.owner.delay, self.owner.fail_at)
        if self.owner.delay:
            await asyncio.sleep(self.owner.delay)
        return self.owner.reply


class _Base(object):
    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.reply = response()
        self.chunks = script(["Hel", "lo"])
        self.delay = 0.0
        self.fail_at: Optional[int] = None
        self.raises: Optional[BaseException] = None


class FakeOpenAI(_Base):
    def __init__(self) -> None:
        super().__init__()
        self.chat = NS(completions=_Completions(self))


class AsyncOpenAI(_Base):  # the name matters: the wrapper recognises async clients by it
    def __init__(self) -> None:
        super().__init__()
        self.chat = NS(completions=_AsyncCompletions(self))


class StubMonitor(object):
    """Records track() calls. `captures_content` mirrors Monitor.captures_content."""

    def __init__(self, enabled: bool = True, capture: bool = False, raises: bool = False) -> None:
        self.enabled = enabled
        self.captures_content = capture
        self.raises = raises
        self.events: List[Dict[str, Any]] = []

    def track(self, **fields: Any) -> Optional[str]:
        if self.raises:
            raise RuntimeError("monitor exploded")
        self.events.append(fields)
        return "id"
