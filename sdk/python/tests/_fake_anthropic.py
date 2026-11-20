"""Duck-typed stand-ins for the Anthropic client (the real package is not a dependency)."""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace as NS
from typing import Any, Dict, List, Optional

from _fake_openai import StubMonitor  # noqa: F401  (re-exported for the tests)


def usage(inp: int = 10, out: int = 5, read: Optional[int] = None, create: Optional[int] = None) -> Any:
    return NS(input_tokens=inp, output_tokens=out, cache_read_input_tokens=read, cache_creation_input_tokens=create)


def message(text: str = "hi", model: str = "claude-sonnet-5-5", use: Any = None, stop: str = "end_turn") -> Any:
    return NS(id="msg_1", model=model, role="assistant", stop_reason=stop, usage=use or usage(),
              content=[NS(type="text", text=text)])


def ev_start(model="claude-sonnet-5-5", use=None) -> Any:
    return NS(type="message_start", message=NS(model=model, usage=use or usage(10, 1)))


def ev_block(kind="text") -> Any:
    return NS(type="content_block_start", index=0, content_block=NS(type=kind, text="" if kind == "text" else None))


def ev_text(t: str) -> Any:
    return NS(type="content_block_delta", index=0, delta=NS(type="text_delta", text=t))


def ev_json(t: str) -> Any:
    return NS(type="content_block_delta", index=0, delta=NS(type="input_json_delta", partial_json=t))


def ev_think(t: str) -> Any:
    return NS(type="content_block_delta", index=0, delta=NS(type="thinking_delta", thinking=t))


def ev_end(out: int = 20, stop="end_turn", **extra) -> Any:
    return NS(type="message_delta", delta=NS(stop_reason=stop), usage=NS(output_tokens=out, input_tokens=extra.get("inp"),
              cache_read_input_tokens=extra.get("read"), cache_creation_input_tokens=extra.get("create")))


STOP = NS(type="message_stop")


def script(texts: List[str], use: Any = None, out: int = 20) -> List[Any]:
    return [ev_start(use=use), ev_block()] + [ev_text(t) for t in texts] + [NS(type="content_block_stop", index=0), ev_end(out), STOP]


class FakeStream(object):
    def __init__(self, events: List[Any], delay: float = 0.0, fail_at: Optional[int] = None) -> None:
        self.events, self.delay, self.fail_at = events, delay, fail_at
        self.closed = False

    def __iter__(self) -> Any:
        for i, e in enumerate(self.events):
            if self.fail_at == i:
                raise ConnectionError("stream dropped")
            if self.delay:
                time.sleep(self.delay)
            yield e

    def close(self) -> None:
        self.closed = True

    def __enter__(self) -> "FakeStream":
        return self

    def __exit__(self, *e: Any) -> None:
        self.close()


class FakeAsyncStream(object):
    def __init__(self, events: List[Any], delay: float = 0.0, fail_at: Optional[int] = None) -> None:
        self.events, self.delay, self.fail_at = events, delay, fail_at
        self.closed = False

    def __aiter__(self) -> Any:
        return self._gen().__aiter__()

    async def _gen(self) -> Any:
        for i, e in enumerate(self.events):
            if self.fail_at == i:
                raise ConnectionError("stream dropped")
            if self.delay:
                await asyncio.sleep(self.delay)
            yield e

    async def close(self) -> None:
        self.closed = True


class _Snap(object):
    """Accumulates like the real MessageStream: usage from message_start, overwritten by message_delta."""

    def __init__(self) -> None:
        self.snapshot: Any = None

    def feed(self, e: Any) -> None:
        if e.type == "message_start":
            m = e.message
            self.snapshot = NS(model=m.model, usage=NS(**vars(m.usage)), stop_reason=None, content=[NS(type="text", text="")])
        elif e.type == "content_block_delta" and e.delta.type == "text_delta":
            self.snapshot.content[0].text += e.delta.text
        elif e.type == "message_delta":
            self.snapshot.stop_reason = e.delta.stop_reason
            self.snapshot.usage.output_tokens = e.usage.output_tokens


class FakeMessageStream(object):
    """What `with client.messages.stream(...) as s` yields."""

    def __init__(self, events: List[Any], delay: float, fail_at: Optional[int]) -> None:
        self._src = FakeStream(events, delay, fail_at)
        self._snap = _Snap()
        self._gen: Any = None

    @property
    def current_message_snapshot(self) -> Any:
        if self._snap.snapshot is None:
            raise RuntimeError("no message_start yet")
        return self._snap.snapshot

    def __iter__(self) -> Any:
        if self._gen is None:
            self._gen = self._run()
        return self._gen

    def _run(self) -> Any:
        for e in self._src:
            self._snap.feed(e)
            yield e
            if e.type == "content_block_delta" and e.delta.type == "text_delta":
                yield NS(type="text", text=e.delta.text, snapshot="")

    @property
    def text_stream(self) -> Any:  # iterates the INNER stream, bypassing any wrapper's __iter__ (like the real one)
        for e in self:
            if e.type == "text":
                yield e.text

    def get_final_message(self) -> Any:
        for _ in self:
            pass
        return self.current_message_snapshot


class FakeManager(object):
    def __init__(self, owner: Any) -> None:
        self.owner = owner
        self.exited = False

    def __enter__(self) -> FakeMessageStream:
        return FakeMessageStream(list(self.owner.events), self.owner.delay, self.owner.fail_at)

    def __exit__(self, *e: Any) -> Any:
        self.exited = True
        return getattr(self.owner, "suppress", False)


class FakeAsyncMessageStream(FakeMessageStream):
    def __init__(self, events: List[Any], delay: float, fail_at: Optional[int]) -> None:
        super().__init__(events, delay, fail_at)
        self._asrc = FakeAsyncStream(events, delay, fail_at)
        self._agen: Any = None

    def __aiter__(self) -> Any:
        if self._agen is None:
            self._agen = self._arun()
        return self._agen

    async def _arun(self) -> Any:
        async for e in self._asrc:
            self._snap.feed(e)
            yield e

    async def get_final_message(self) -> Any:  # type: ignore[override]
        async for _ in self:
            pass
        return self.current_message_snapshot


class FakeAsyncManager(FakeManager):
    async def __aenter__(self) -> FakeAsyncMessageStream:
        return FakeAsyncMessageStream(list(self.owner.events), self.owner.delay, self.owner.fail_at)

    async def __aexit__(self, *e: Any) -> None:
        self.exited = True


class _Messages(object):
    def __init__(self, owner: Any) -> None:
        self.owner = owner

    def create(self, **kw: Any) -> Any:
        self.owner.calls.append(kw)
        if self.owner.raises:
            raise self.owner.raises
        if kw.get("stream"):
            return FakeStream(list(self.owner.events), self.owner.delay, self.owner.fail_at)
        if self.owner.delay:
            time.sleep(self.owner.delay)
        return self.owner.reply

    def stream(self, **kw: Any) -> Any:
        self.owner.calls.append(dict(kw, _helper=True))
        if self.owner.raises:
            raise self.owner.raises
        return FakeManager(self.owner)


class _AsyncMessages(_Messages):
    async def create(self, **kw: Any) -> Any:  # type: ignore[override]
        self.owner.calls.append(kw)
        if self.owner.raises:
            raise self.owner.raises
        if kw.get("stream"):
            return FakeAsyncStream(list(self.owner.events), self.owner.delay, self.owner.fail_at)
        if self.owner.delay:
            await asyncio.sleep(self.owner.delay)
        return self.owner.reply

    def stream(self, **kw: Any) -> Any:  # sync function returning an async manager, like the real SDK
        self.owner.calls.append(dict(kw, _helper=True))
        return FakeAsyncManager(self.owner)


class _Base(object):
    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.reply = message()
        self.events = script(["Hel", "lo"])
        self.delay = 0.0
        self.fail_at: Optional[int] = None
        self.raises: Optional[BaseException] = None


class FakeAnthropic(_Base):
    def __init__(self) -> None:
        super().__init__()
        self.messages = _Messages(self)


class AsyncAnthropic(_Base):  # the name matters: async clients are recognised by it as a fallback
    def __init__(self) -> None:
        super().__init__()
        self.messages = _AsyncMessages(self)
