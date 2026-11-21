"""The OpenAI wrapper against the REAL `openai` package, talking to a local fake HTTP server (see _fake_provider.py).

Covers sync and async, streaming and not, usage and cached tokens, time to first token, the injected `stream_options`, and that
a failing call raises exactly what the unwrapped client raises. No network, no API key. Skipped locally when `openai` is not
installed; in CI (LLM_MONITOR_REQUIRE_REAL_SDKS=1) a missing or wrong-version package fails."""
from __future__ import annotations

import gc
import os
import unittest
from typing import Any, List

from _real import REQUIRE, pinned, require

openai = require("openai")

from _fake_provider import Drop, Json, ProviderServer, openai_completion, openai_stream  # noqa: E402
from _fake_openai import StubMonitor  # noqa: E402
from llm_monitor import hash_prompt  # noqa: E402
from llm_monitor.integrations.openai import instrument_openai, uninstrument_openai  # noqa: E402

MSGS = [{"role": "user", "content": "What is 2+2?"}]
ERROR_BODY = {"error": {"message": "bad request body", "type": "invalid_request_error", "param": None, "code": None}}


def client_for(server: ProviderServer, async_: bool = False) -> Any:
    cls = openai.AsyncOpenAI if async_ else openai.OpenAI
    return cls(api_key="sk-test-not-a-real-key", base_url=server.base + "/v1", max_retries=0, timeout=10.0)


def texts(chunks: List[Any]) -> str:
    return "".join((c.choices[0].delta.content or "") for c in chunks if c.choices)


class TestEnvironment(unittest.TestCase):
    def test_the_installed_package_is_the_pinned_one(self):
        if not REQUIRE:
            self.skipTest("version pins are enforced in CI (LLM_MONITOR_REQUIRE_REAL_SDKS=1)")
        file = "requirements-providers-legacy.txt" if os.environ.get("LLM_MONITOR_PIN_SET") == "legacy" else "requirements-providers.txt"
        self.assertEqual(openai.__version__, pinned(file)["openai"])



class TestSync(unittest.TestCase):
    def setUp(self):
        self.server = ProviderServer()
        self.addCleanup(self.server.close)
        self.mon = StubMonitor()
        self.client = instrument_openai(client_for(self.server), self.mon)
        self.addCleanup(self.client.close)

    def test_create_records_model_tokens_cached_tokens_and_prompt_hash(self):
        self.server.script(Json(openai_completion("4", model="gpt-4o-2024-08-06", prompt=1200, completion=30, cached=1024), delay=0.03))
        res = self.client.chat.completions.create(model="gpt-4o", messages=MSGS)
        self.assertIsInstance(res, openai.types.chat.ChatCompletion)  # the caller gets the real typed object back
        self.assertEqual(res.choices[0].message.content, "4")
        (e,) = self.mon.events
        self.assertEqual((e["kind"], e["provider"], e["name"]), ("llm", "openai", "chat.completions"))
        self.assertEqual(e["model"], "gpt-4o-2024-08-06")
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (1200, 30, 1024))
        self.assertGreaterEqual(e["latency_ms"], 25)
        self.assertEqual(hash_prompt(e["prompt"]), hash_prompt(MSGS))
        self.assertNotIn("status", e)
        self.assertNotIn("ttft_ms", e)
        self.assertNotIn("content", e)
        sent = self.server.requests[0]
        self.assertEqual(sent["path"], "/v1/chat/completions")
        self.assertEqual(sent["body"]["messages"], MSGS)  # forwarded untouched
        self.assertNotIn("stream_options", sent["body"])

    def test_no_cached_details_means_cached_is_absent(self):
        self.server.script(Json(openai_completion(prompt=10, completion=2, cached=None)))
        self.client.chat.completions.create(model="m", messages=MSGS)
        (e,) = self.mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"]), (10, 2))
        self.assertIsNone(e["cached_tokens"])

    def test_stream_injects_usage_hides_the_extra_chunk_and_measures_ttft(self):
        self.server.script(openai_stream(("Hel", "lo", "!"), prompt=50, completion=3, cached=32, first_delay=0.15))
        stream = self.client.chat.completions.create(model="gpt-4o", messages=MSGS, stream=True)
        chunks = list(stream)
        self.assertEqual(self.server.requests[0]["body"]["stream_options"], {"include_usage": True})  # injected on the wire
        self.assertEqual(texts(chunks), "Hello!")
        self.assertTrue(all(c.choices for c in chunks))  # the usage-only chunk (empty choices) never reaches the caller
        (e,) = self.mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (50, 3, 32))
        self.assertEqual(e["model"], "gpt-4o-2024-08-06")
        self.assertEqual(e["tags"], ["stream"])
        self.assertNotIn("status", e)
        self.assertGreaterEqual(e["ttft_ms"], 120)  # the role-only first chunk did not count as the first token
        self.assertLessEqual(e["ttft_ms"], e["latency_ms"])

    def test_the_callers_own_stream_options_are_left_alone_and_the_usage_chunk_is_passed_through(self):
        self.server.script(openai_stream(("a", "b"), prompt=7, completion=2))
        chunks = list(self.client.chat.completions.create(model="m", messages=MSGS, stream=True, stream_options={"include_usage": True}))
        self.assertEqual(self.server.requests[0]["body"]["stream_options"], {"include_usage": True})
        self.assertTrue(any(not c.choices and c.usage for c in chunks))  # they asked for it, so they get it
        (e,) = self.mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"]), (7, 2))

    def test_stream_as_a_context_manager_and_abandoned_stream(self):
        self.server.script(openai_stream(("a", "b", "c", "d")), openai_stream(("x", "y")))
        with self.client.chat.completions.create(model="m", messages=MSGS, stream=True) as stream:
            self.assertEqual(texts([next(stream), next(stream), next(stream)]), "ab")  # role chunk, "a", "b"
        (e,) = self.mon.events
        self.assertEqual(e["tags"], ["stream", "incomplete"])  # left early: reported once, as incomplete
        stream = self.client.chat.completions.create(model="m", messages=MSGS, stream=True)
        next(stream)
        del stream
        gc.collect()
        self.assertEqual(len(self.mon.events), 2)
        self.assertIn("incomplete", self.mon.events[1]["tags"])

    def test_the_content_is_captured_only_when_the_monitor_opted_in(self):
        self.server.script(Json(openai_completion("plain")), Json(openai_completion("secret answer")), openai_stream(("str", "eam")))
        self.client.chat.completions.create(model="m", messages=MSGS)
        self.assertNotIn("content", self.mon.events[0])
        mon = StubMonitor(capture=True)
        client = instrument_openai(client_for(self.server), mon)
        self.addCleanup(client.close)
        client.chat.completions.create(model="m", messages=MSGS)
        list(client.chat.completions.create(model="m", messages=MSGS, stream=True))
        self.assertEqual(mon.events[0]["content"]["output"], "secret answer")
        self.assertIn("What is 2+2?", mon.events[0]["content"]["input"])
        self.assertEqual(mon.events[1]["content"]["output"], "stream")

    def test_instrument_twice_and_uninstrument_on_the_real_client(self):
        self.server.script(Json(openai_completion()), Json(openai_completion()))
        again = instrument_openai(self.client, self.mon)
        self.assertIs(again, self.client)
        self.client.chat.completions.create(model="m", messages=MSGS)
        self.assertEqual(len(self.mon.events), 1)  # not double-wrapped
        uninstrument_openai(self.client)
        self.client.chat.completions.create(model="m", messages=MSGS)
        self.assertEqual(len(self.mon.events), 1)


class TestRawResponses(unittest.TestCase):
    """Found by running against the real package: `with_raw_response` / `with_streaming_response` are built on the patched `create`
    and used to be recorded as events with empty usage. They are documented as not instrumented, so they must pass through."""

    def setUp(self):
        self.server = ProviderServer()
        self.addCleanup(self.server.close)
        self.mon = StubMonitor()
        self.client = instrument_openai(client_for(self.server), self.mon)
        self.addCleanup(self.client.close)

    def test_with_raw_response_passes_through_unrecorded_and_still_parses(self):
        self.server.script(Json(openai_completion("4")))
        raw = self.client.chat.completions.with_raw_response.create(model="m", messages=MSGS)
        self.assertEqual(raw.parse().choices[0].message.content, "4")
        self.assertEqual(self.mon.events, [])

    def test_with_streaming_response_passes_through_unrecorded(self):
        self.server.script(Json(openai_completion("4")))
        with self.client.chat.completions.with_streaming_response.create(model="m", messages=MSGS) as resp:
            self.assertEqual(resp.parse().choices[0].message.content, "4")
        self.assertEqual(self.mon.events, [])

    def test_a_raw_streaming_call_gets_no_injected_stream_options(self):
        self.server.script(openai_stream(("a",), usage=False))
        with self.client.chat.completions.with_streaming_response.create(model="m", messages=MSGS, stream=True) as resp:
            list(resp.parse())
        self.assertNotIn("stream_options", self.server.requests[0]["body"])
        self.assertEqual(self.mon.events, [])

    def test_the_callers_own_extra_headers_do_not_disable_recording(self):
        self.server.script(Json(openai_completion()))
        self.client.chat.completions.create(model="m", messages=MSGS, extra_headers={"X-Mine": "1"})
        self.assertEqual(len(self.mon.events), 1)
        self.assertEqual(self.server.requests[0]["headers"]["x-mine"], "1")

    def test_the_stream_object_still_exposes_the_response(self):
        self.server.script(openai_stream(("a",)))
        stream = self.client.chat.completions.create(model="m", messages=MSGS, stream=True)
        self.assertEqual(stream.response.status_code, 200)  # delegated to the real Stream
        list(stream)


class TestSyncErrors(unittest.TestCase):
    """A failing call raises exactly what the unwrapped client raises, and is recorded once as an error."""

    def setUp(self):
        self.server = ProviderServer()
        self.addCleanup(self.server.close)
        self.mon = StubMonitor()

    def both(self, reply: Any, **create_kwargs: Any):
        """Runs the same scripted failure through a plain and an instrumented client; returns (plain_exc, wrapped_exc)."""
        out = []
        for wrap in (False, True):
            self.server.script(reply)
            client = client_for(self.server)
            if wrap:
                instrument_openai(client, self.mon)
            self.addCleanup(client.close)
            try:
                result = client.chat.completions.create(model="m", messages=MSGS, **create_kwargs)
                if create_kwargs.get("stream"):
                    list(result)
            except BaseException as err:  # noqa: B902 - the test compares what was raised
                out.append(err)
            else:
                self.fail("the call was expected to fail")
        return out[0], out[1]

    def check_same(self, plain: BaseException, wrapped: BaseException, expected_type: type) -> None:
        self.assertIsInstance(wrapped, expected_type)
        self.assertIs(type(wrapped), type(plain))
        self.assertEqual(str(wrapped), str(plain))
        self.assertEqual(getattr(wrapped, "status_code", None), getattr(plain, "status_code", None))
        self.assertEqual(len(self.mon.events), 1)  # the plain client reports nothing; the wrapped one reports once
        e = self.mon.events[0]
        self.assertEqual(e["status"], "error")
        self.assertTrue(e["error"].startswith(type(wrapped).__name__))

    def test_400_raises_bad_request_error(self):
        plain, wrapped = self.both(Json(ERROR_BODY, status=400))
        self.check_same(plain, wrapped, openai.BadRequestError)
        self.assertEqual(wrapped.status_code, 400)

    def test_429_and_500_raise_the_same_typed_errors(self):
        plain, wrapped = self.both(Json(ERROR_BODY, status=429))
        self.check_same(plain, wrapped, openai.RateLimitError)
        self.mon.events.clear()
        plain, wrapped = self.both(Json(ERROR_BODY, status=500))
        self.check_same(plain, wrapped, openai.InternalServerError)

    def test_connection_dropped_raises_api_connection_error(self):
        plain, wrapped = self.both(Drop())
        self.check_same(plain, wrapped, openai.APIConnectionError)

    def test_connection_refused_raises_api_connection_error(self):
        server = ProviderServer()
        base = server.base
        server.close()  # nothing listens on this port any more
        client = openai.OpenAI(api_key="x", base_url=base + "/v1", max_retries=0, timeout=5.0)
        self.addCleanup(client.close)
        instrument_openai(client, self.mon)
        with self.assertRaises(openai.APIConnectionError):
            client.chat.completions.create(model="m", messages=MSGS)
        self.assertEqual(self.mon.events[0]["status"], "error")

    def test_a_stream_cut_mid_way_raises_what_the_plain_client_raises_and_is_recorded_once(self):
        plain, wrapped = self.both(openai_stream(("a", "b", "c"), cut_after=3), stream=True)  # role chunk, "a", "b", then the connection dies
        self.assertIs(type(wrapped), type(plain))
        self.assertEqual(str(wrapped), str(plain))
        self.assertEqual(len(self.mon.events), 1)
        self.assertEqual(self.mon.events[0]["status"], "error")
        self.assertEqual(self.mon.events[0]["tags"], ["stream"])

    def test_an_error_event_inside_the_stream_raises_the_real_api_error_and_is_recorded_once(self):
        err = {"error": {"message": "the server had an error", "type": "server_error", "code": None}}
        stream = openai_stream(("a",), usage=False)
        stream.events.insert(2, (None, err))
        plain, wrapped = self.both(stream, stream=True)
        self.assertIsInstance(wrapped, openai.APIError)
        self.assertIs(type(wrapped), type(plain))
        self.assertEqual(self.mon.events[0]["status"], "error")

    def test_a_broken_monitor_never_changes_what_the_caller_sees(self):
        broken = StubMonitor(raises=True)
        self.server.script(Json(openai_completion("fine")), Json(ERROR_BODY, status=400))
        client = instrument_openai(client_for(self.server), broken)
        self.addCleanup(client.close)
        self.assertEqual(client.chat.completions.create(model="m", messages=MSGS).choices[0].message.content, "fine")
        with self.assertRaises(openai.BadRequestError):
            client.chat.completions.create(model="m", messages=MSGS)


class TestAsyncRaw(unittest.IsolatedAsyncioTestCase):
    async def test_async_with_raw_response_passes_through_unrecorded(self):
        server = ProviderServer()
        self.addCleanup(server.close)
        mon = StubMonitor()
        client = instrument_openai(client_for(server, async_=True), mon)
        self.addAsyncCleanup(client.close)
        server.script(Json(openai_completion("4")))
        raw = await client.chat.completions.with_raw_response.create(model="m", messages=MSGS)
        parsed = raw.parse()
        if hasattr(parsed, "__await__"):  # AsyncAPIResponse.parse is a coroutine, the legacy raw response's is not (differs by package version)
            parsed = await parsed
        self.assertEqual(parsed.choices[0].message.content, "4")
        self.assertEqual(mon.events, [])


class TestAsync(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = ProviderServer()
        self.addCleanup(self.server.close)
        self.mon = StubMonitor()
        self.client = instrument_openai(client_for(self.server, async_=True), self.mon)
        self.addAsyncCleanup(self.client.close)

    async def test_async_create_records_tokens(self):
        self.server.script(Json(openai_completion("4", prompt=99, completion=4, cached=64)))
        res = await self.client.chat.completions.create(model="gpt-4o", messages=MSGS)
        self.assertEqual(res.choices[0].message.content, "4")
        (e,) = self.mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (99, 4, 64))
        self.assertEqual(e["provider"], "openai")

    async def test_async_stream_injects_usage_hides_the_chunk_and_measures_ttft(self):
        self.server.script(openai_stream(("Hel", "lo"), prompt=20, completion=2, cached=8, first_delay=0.15))
        stream = await self.client.chat.completions.create(model="gpt-4o", messages=MSGS, stream=True)
        chunks = [c async for c in stream]
        self.assertEqual(self.server.requests[0]["body"]["stream_options"], {"include_usage": True})
        self.assertEqual(texts(chunks), "Hello")
        self.assertTrue(all(c.choices for c in chunks))
        (e,) = self.mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (20, 2, 8))
        self.assertGreaterEqual(e["ttft_ms"], 120)
        self.assertLessEqual(e["ttft_ms"], e["latency_ms"])

    async def test_async_stream_abandoned_with_aclose(self):
        self.server.script(openai_stream(("a", "b", "c")))
        stream = await self.client.chat.completions.create(model="m", messages=MSGS, stream=True)
        await stream.__anext__()
        await stream.close()
        self.assertEqual(self.mon.events[0]["tags"], ["stream", "incomplete"])

    async def test_async_errors_reraise_the_original_exception(self):
        self.server.script(Json(ERROR_BODY, status=400), Json(ERROR_BODY, status=429), Drop())
        with self.assertRaises(openai.BadRequestError) as bad:
            await self.client.chat.completions.create(model="m", messages=MSGS)
        self.assertEqual(bad.exception.status_code, 400)
        with self.assertRaises(openai.RateLimitError):
            await self.client.chat.completions.create(model="m", messages=MSGS)
        with self.assertRaises(openai.APIConnectionError):
            await self.client.chat.completions.create(model="m", messages=MSGS)
        self.assertEqual([e["status"] for e in self.mon.events], ["error", "error", "error"])
        self.assertTrue(self.mon.events[0]["error"].startswith("BadRequestError"))

    async def test_async_stream_cut_mid_way_is_recorded_once_as_an_error(self):
        self.server.script(openai_stream(("a", "b", "c"), cut_after=3))
        stream = await self.client.chat.completions.create(model="m", messages=MSGS, stream=True)
        with self.assertRaises(Exception) as caught:
            async for _ in stream:
                pass
        self.assertNotIsInstance(caught.exception, StopAsyncIteration)
        self.assertEqual(len(self.mon.events), 1)
        self.assertEqual(self.mon.events[0]["status"], "error")


class TestWithTheRealMonitor(unittest.TestCase):
    """Real client + real Monitor + a local ingest server: what is sent is hashed, totalled and free of raw text."""

    def test_what_reaches_the_ingest_endpoint(self):
        from _helpers import API_KEY, IngestServer, wait_until
        from llm_monitor import Monitor, span

        provider = ProviderServer()
        self.addCleanup(provider.close)
        ingest = IngestServer()
        ingest.__enter__()
        self.addCleanup(ingest.__exit__, None, None, None)
        mon = Monitor(API_KEY, ingest.url, flush_interval_ms=60_000, min_flush_interval_ms=20, hash_salt="s")
        self.addCleanup(lambda: mon.close(5))
        client = instrument_openai(client_for(provider), mon)
        self.addCleanup(client.close)
        provider.script(Json(openai_completion("sure, bob@example.com", prompt=80, completion=9, cached=16)))
        msgs = [{"role": "user", "content": "my card is 4111 1111 1111 1111, mail bob@example.com"}]
        with span("agent", kind="agent", monitor=mon):
            client.chat.completions.create(model="gpt-4o", messages=msgs)
        self.assertTrue(mon.flush(5))
        self.assertTrue(wait_until(lambda: len(ingest.requests) >= 1))
        events = [e for r in ingest.requests for e in r["body"]["events"]]
        llm = next(e for e in events if e["kind"] == "llm")
        agent = next(e for e in events if e["kind"] == "agent")
        self.assertEqual((llm["input_tokens"], llm["output_tokens"], llm["cached_tokens"]), (80, 9, 16))
        self.assertEqual(llm["parent_id"], agent["span_id"])
        self.assertNotIn("content", llm)
        wire = repr(ingest.requests)
        for raw in ("4111 1111", "bob@example.com", "my card", "sk-test-not-a-real-key"):
            self.assertNotIn(raw, wire)


if __name__ == "__main__":
    unittest.main()
