"""The Anthropic wrapper against the REAL `anthropic` package, talking to a local fake HTTP server (see _fake_provider.py).

Covers sync and async: `messages.create` (plain and `stream=True`) and the `messages.stream()` helper, the token convention
(input = input + cache read + cache creation, cached = cache read), time to first token, and that a failing call raises exactly
what the unwrapped client raises. No network, no API key. Skipped locally when `anthropic` is not installed; in CI
(LLM_MONITOR_REQUIRE_REAL_SDKS=1) a missing or wrong-version package fails."""
from __future__ import annotations

import os
import unittest
from typing import Any

from _real import REQUIRE, pinned, require

anthropic = require("anthropic")

from _fake_provider import Drop, Json, ProviderServer, anthropic_message, anthropic_stream  # noqa: E402
from _fake_openai import StubMonitor  # noqa: E402
from llm_monitor import hash_prompt  # noqa: E402
from llm_monitor.integrations.anthropic import instrument_anthropic, uninstrument_anthropic  # noqa: E402

MSGS = [{"role": "user", "content": "What is 2+2?"}]
ARGS = dict(model="claude-sonnet-5-5", max_tokens=64, messages=MSGS)
ERROR_BODY = {"type": "error", "error": {"type": "invalid_request_error", "message": "bad request body"}}


def client_for(server: ProviderServer, async_: bool = False) -> Any:
    cls = anthropic.AsyncAnthropic if async_ else anthropic.Anthropic
    return cls(api_key="sk-ant-test-not-a-real-key", base_url=server.base, max_retries=0, timeout=10.0)


class TestEnvironment(unittest.TestCase):
    def test_the_installed_package_is_the_pinned_one(self):
        if not REQUIRE:
            self.skipTest("version pins are enforced in CI (LLM_MONITOR_REQUIRE_REAL_SDKS=1)")
        file = "requirements-providers-legacy.txt" if os.environ.get("LLM_MONITOR_PIN_SET") == "legacy" else "requirements-providers.txt"
        self.assertEqual(anthropic.__version__, pinned(file)["anthropic"])


class TestSync(unittest.TestCase):
    def setUp(self):
        self.server = ProviderServer()
        self.addCleanup(self.server.close)
        self.mon = StubMonitor()
        self.client = instrument_anthropic(client_for(self.server), self.mon)
        self.addCleanup(self.client.close)

    def test_create_total_input_is_input_plus_cache_read_plus_cache_creation(self):
        self.server.script(Json(anthropic_message("4", input_tokens=10, output_tokens=7, cache_read=1000, cache_creation=200), delay=0.03))
        res = self.client.messages.create(**ARGS)
        self.assertEqual(res.content[0].text, "4")  # the caller gets the real typed Message back
        (e,) = self.mon.events
        self.assertEqual((e["kind"], e["provider"], e["name"]), ("llm", "anthropic", "messages"))
        self.assertEqual(e["model"], "claude-sonnet-5-5")
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (1210, 7, 1000))
        self.assertGreaterEqual(e["latency_ms"], 25)
        self.assertEqual(hash_prompt(e["prompt"]), hash_prompt(MSGS))
        self.assertNotIn("status", e)
        self.assertNotIn("content", e)
        sent = self.server.requests[0]
        self.assertEqual(sent["path"], "/v1/messages")
        self.assertEqual(sent["body"]["messages"], MSGS)

    def test_a_response_without_cache_fields(self):
        self.server.script(Json(anthropic_message(input_tokens=30, output_tokens=5)))
        self.client.messages.create(**ARGS)
        (e,) = self.mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"]), (30, 5))

    def test_the_system_prompt_is_part_of_the_prompt_hash(self):
        self.server.script(Json(anthropic_message()), Json(anthropic_message()))
        self.client.messages.create(system="be terse", **ARGS)
        self.client.messages.create(**ARGS)
        self.assertNotEqual(hash_prompt(self.mon.events[0]["prompt"]), hash_prompt(self.mon.events[1]["prompt"]))
        self.assertEqual(self.server.requests[0]["body"]["system"], "be terse")

    def test_create_stream_totals_cumulative_usage_and_ttft_skips_the_empty_block_start(self):
        self.server.script(anthropic_stream(("Hel", "lo"), input_tokens=40, output_tokens=9, cache_read=30, cache_creation=5, first_delay=0.15))
        events = list(self.client.messages.create(stream=True, **ARGS))
        self.assertEqual([getattr(e, "type") for e in events][0], "message_start")
        self.assertEqual(self.server.requests[0]["body"]["stream"], True)
        (e,) = self.mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (75, 9, 30))  # 40 + 30 + 5; output replaced, not added
        self.assertEqual(e["tags"], ["stream"])
        self.assertGreaterEqual(e["ttft_ms"], 120)
        self.assertLessEqual(e["ttft_ms"], e["latency_ms"])
        self.assertNotIn("status", e)

    def test_create_stream_abandoned_is_reported_once_as_incomplete(self):
        self.server.script(anthropic_stream(("a", "b", "c")))
        stream = self.client.messages.create(stream=True, **ARGS)
        next(stream)
        next(stream)
        stream.close()
        self.assertEqual(len(self.mon.events), 1)
        self.assertEqual(self.mon.events[0]["tags"], ["stream", "incomplete"])

    def test_helper_stream_iterating_gives_tokens_snapshot_and_ttft(self):
        self.server.script(anthropic_stream(("Hel", "lo"), input_tokens=40, output_tokens=9, cache_read=30, first_delay=0.15))
        with self.client.messages.stream(**ARGS) as stream:
            seen = [e.type for e in stream]
        self.assertIn("text", seen)  # the helper's own events still reach the caller
        (e,) = self.mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (70, 9, 30))
        self.assertGreaterEqual(e["ttft_ms"], 120)
        self.assertNotIn("status", e)

    def test_helper_text_stream_and_final_message_still_work_and_tokens_come_from_the_snapshot(self):
        self.server.script(anthropic_stream(("Hel", "lo"), input_tokens=11, output_tokens=4))
        with self.client.messages.stream(**ARGS) as stream:
            text = "".join(stream.text_stream)  # bypasses the wrapper's iteration: no TTFT, but tokens are still read at exit
            final = stream.get_final_message()
        self.assertEqual(text, "Hello")
        self.assertEqual(final.usage.output_tokens, 4)
        (e,) = self.mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"]), (11, 4))
        self.assertEqual(e["model"], "claude-sonnet-5-5")

    def test_helper_stream_left_early_is_incomplete(self):
        self.server.script(anthropic_stream(("a", "b", "c")))
        with self.client.messages.stream(**ARGS) as stream:
            next(iter(stream))
        self.assertEqual(len(self.mon.events), 1)
        self.assertIn("incomplete", self.mon.events[0]["tags"])

    def test_content_is_captured_only_when_the_monitor_opted_in(self):
        self.server.script(Json(anthropic_message("secret answer")), Json(anthropic_message("second")))
        self.client.messages.create(**ARGS)
        self.assertNotIn("content", self.mon.events[0])
        mon = StubMonitor(capture=True)
        client = instrument_anthropic(client_for(self.server), mon)
        self.addCleanup(client.close)
        client.messages.create(**ARGS)
        self.assertEqual(mon.events[0]["content"]["output"], "second")
        self.assertIn("What is 2+2?", mon.events[0]["content"]["input"])

    def test_instrument_twice_and_uninstrument_on_the_real_client(self):
        self.server.script(Json(anthropic_message()), Json(anthropic_message()))
        self.assertIs(instrument_anthropic(self.client, self.mon), self.client)
        self.client.messages.create(**ARGS)
        self.assertEqual(len(self.mon.events), 1)
        uninstrument_anthropic(self.client)
        self.client.messages.create(**ARGS)
        self.assertEqual(len(self.mon.events), 1)


class TestRawResponses(unittest.TestCase):
    """Found by running against the real package: `with_raw_response` / `with_streaming_response` are built on the patched `create`
    and used to be recorded as events with empty usage. They are documented as not instrumented, so they must pass through."""

    def setUp(self):
        self.server = ProviderServer()
        self.addCleanup(self.server.close)
        self.mon = StubMonitor()
        self.client = instrument_anthropic(client_for(self.server), self.mon)
        self.addCleanup(self.client.close)

    def test_with_raw_response_passes_through_unrecorded_and_still_parses(self):
        self.server.script(Json(anthropic_message("4")))
        raw = self.client.messages.with_raw_response.create(**ARGS)
        self.assertEqual(raw.parse().content[0].text, "4")
        self.assertEqual(self.mon.events, [])

    def test_with_streaming_response_passes_through_unrecorded(self):
        self.server.script(Json(anthropic_message("4")))
        with self.client.messages.with_streaming_response.create(**ARGS) as resp:
            self.assertEqual(resp.parse().content[0].text, "4")
        self.assertEqual(self.mon.events, [])

    def test_the_callers_own_extra_headers_do_not_disable_recording(self):
        self.server.script(Json(anthropic_message()))
        self.client.messages.create(extra_headers={"X-Mine": "1"}, **ARGS)
        self.assertEqual(len(self.mon.events), 1)
        self.assertEqual(self.server.requests[0]["headers"]["x-mine"], "1")

    def test_the_stream_object_still_exposes_the_response(self):
        self.server.script(anthropic_stream(("a",)))
        stream = self.client.messages.create(stream=True, **ARGS)
        self.assertEqual(stream.response.status_code, 200)
        list(stream)


class TestSyncErrors(unittest.TestCase):
    """A failing call raises exactly what the unwrapped client raises, and is recorded once as an error."""

    def setUp(self):
        self.server = ProviderServer()
        self.addCleanup(self.server.close)
        self.mon = StubMonitor()

    def both(self, reply: Any, helper: bool = False, **create_kwargs: Any):
        out = []
        for wrap in (False, True):
            self.server.script(reply)
            client = client_for(self.server)
            if wrap:
                instrument_anthropic(client, self.mon)
            self.addCleanup(client.close)
            try:
                if helper:
                    with client.messages.stream(**ARGS) as stream:
                        list(stream)
                else:
                    result = client.messages.create(**ARGS, **create_kwargs)
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
        self.assertEqual(len(self.mon.events), 1)
        e = self.mon.events[0]
        self.assertEqual(e["status"], "error")
        self.assertTrue(e["error"].startswith(type(wrapped).__name__))

    def test_400_raises_bad_request_error(self):
        plain, wrapped = self.both(Json(ERROR_BODY, status=400))
        self.check_same(plain, wrapped, anthropic.BadRequestError)
        self.assertEqual(wrapped.status_code, 400)

    def test_429_and_529_raise_the_same_typed_errors(self):
        plain, wrapped = self.both(Json({"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}, status=429))
        self.check_same(plain, wrapped, anthropic.RateLimitError)
        self.mon.events.clear()
        plain, wrapped = self.both(Json({"type": "error", "error": {"type": "overloaded_error", "message": "overloaded"}}, status=529))
        self.check_same(plain, wrapped, anthropic.APIStatusError)  # 529 has no dedicated class in every release

    def test_connection_dropped_raises_api_connection_error(self):
        plain, wrapped = self.both(Drop())
        self.check_same(plain, wrapped, anthropic.APIConnectionError)

    def test_connection_refused_raises_api_connection_error(self):
        server = ProviderServer()
        base = server.base
        server.close()
        client = anthropic.Anthropic(api_key="x", base_url=base, max_retries=0, timeout=5.0)
        self.addCleanup(client.close)
        instrument_anthropic(client, self.mon)
        with self.assertRaises(anthropic.APIConnectionError):
            client.messages.create(**ARGS)
        self.assertEqual(self.mon.events[0]["status"], "error")

    def test_create_stream_cut_mid_way_raises_what_the_plain_client_raises_and_is_recorded_once(self):
        plain, wrapped = self.both(anthropic_stream(("a", "b", "c"), cut_after=4), stream=True)
        self.assertIs(type(wrapped), type(plain))
        self.assertEqual(len(self.mon.events), 1)
        self.assertEqual(self.mon.events[0]["status"], "error")
        self.assertEqual(self.mon.events[0]["tags"], ["stream"])

    def test_an_error_event_inside_the_stream_raises_the_real_api_error(self):
        stream = anthropic_stream(("a",))
        stream.events.insert(3, ("error", {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}))
        plain, wrapped = self.both(stream, stream=True)
        self.assertIsInstance(wrapped, anthropic.APIError)
        self.assertIs(type(wrapped), type(plain))
        self.assertEqual(self.mon.events[0]["status"], "error")

    def test_helper_stream_error_inside_the_with_block_is_recorded_and_reraised(self):
        plain, wrapped = self.both(anthropic_stream(("a", "b"), cut_after=4), helper=True)
        self.assertIs(type(wrapped), type(plain))
        self.assertEqual(len(self.mon.events), 1)
        self.assertEqual(self.mon.events[0]["status"], "error")

    def test_helper_error_status_when_opening_the_stream(self):
        plain, wrapped = self.both(Json(ERROR_BODY, status=400), helper=True)
        self.check_same(plain, wrapped, anthropic.BadRequestError)

    def test_an_exception_raised_by_the_callers_own_code_inside_the_with_block_propagates_unchanged(self):
        self.server.script(anthropic_stream(("a", "b")))
        client = instrument_anthropic(client_for(self.server), self.mon)
        self.addCleanup(client.close)
        with self.assertRaises(ZeroDivisionError):
            with client.messages.stream(**ARGS) as stream:
                next(iter(stream))
                1 / 0  # noqa: B018
        self.assertEqual(self.mon.events[0]["status"], "error")
        self.assertTrue(self.mon.events[0]["error"].startswith("ZeroDivisionError"))

    def test_a_broken_monitor_never_changes_what_the_caller_sees(self):
        broken = StubMonitor(raises=True)
        self.server.script(Json(anthropic_message("fine")), Json(ERROR_BODY, status=400))
        client = instrument_anthropic(client_for(self.server), broken)
        self.addCleanup(client.close)
        self.assertEqual(client.messages.create(**ARGS).content[0].text, "fine")
        with self.assertRaises(anthropic.BadRequestError):
            client.messages.create(**ARGS)


class TestAsync(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = ProviderServer()
        self.addCleanup(self.server.close)
        self.mon = StubMonitor()
        self.client = instrument_anthropic(client_for(self.server, async_=True), self.mon)
        self.addAsyncCleanup(self.client.close)

    async def test_async_create_records_tokens(self):
        self.server.script(Json(anthropic_message("4", input_tokens=9, output_tokens=2, cache_read=100, cache_creation=20)))
        res = await self.client.messages.create(**ARGS)
        self.assertEqual(res.content[0].text, "4")
        (e,) = self.mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (129, 2, 100))

    async def test_async_create_stream_tokens_and_ttft(self):
        self.server.script(anthropic_stream(("Hel", "lo"), input_tokens=20, output_tokens=6, cache_read=10, first_delay=0.15))
        stream = await self.client.messages.create(stream=True, **ARGS)
        events = [e async for e in stream]
        self.assertEqual(events[0].type, "message_start")
        (e,) = self.mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (30, 6, 10))
        self.assertGreaterEqual(e["ttft_ms"], 120)
        self.assertLessEqual(e["ttft_ms"], e["latency_ms"])

    async def test_async_helper_stream_iterating_and_get_final_message(self):
        self.server.script(anthropic_stream(("Hel", "lo"), input_tokens=12, output_tokens=3, first_delay=0.15), anthropic_stream(("x", "y"), input_tokens=5, output_tokens=2))
        async with self.client.messages.stream(**ARGS) as stream:
            kinds = [e.type async for e in stream]
        self.assertIn("text", kinds)
        self.assertGreaterEqual(self.mon.events[0]["ttft_ms"], 120)
        self.assertEqual((self.mon.events[0]["input_tokens"], self.mon.events[0]["output_tokens"]), (12, 3))
        async with self.client.messages.stream(**ARGS) as stream:
            final = await stream.get_final_message()
        self.assertEqual(final.usage.output_tokens, 2)
        self.assertEqual((self.mon.events[1]["input_tokens"], self.mon.events[1]["output_tokens"]), (5, 2))

    async def test_async_errors_reraise_the_original_exception(self):
        self.server.script(Json(ERROR_BODY, status=400), Json({"type": "error", "error": {"type": "rate_limit_error", "message": "slow"}}, status=429), Drop())
        with self.assertRaises(anthropic.BadRequestError) as bad:
            await self.client.messages.create(**ARGS)
        self.assertEqual(bad.exception.status_code, 400)
        with self.assertRaises(anthropic.RateLimitError):
            await self.client.messages.create(**ARGS)
        with self.assertRaises(anthropic.APIConnectionError):
            await self.client.messages.create(**ARGS)
        self.assertEqual([e["status"] for e in self.mon.events], ["error", "error", "error"])
        self.assertTrue(self.mon.events[0]["error"].startswith("BadRequestError"))

    async def test_async_stream_cut_mid_way_is_recorded_once_as_an_error(self):
        self.server.script(anthropic_stream(("a", "b", "c"), cut_after=4))
        stream = await self.client.messages.create(stream=True, **ARGS)
        with self.assertRaises(Exception) as caught:
            async for _ in stream:
                pass
        self.assertNotIsInstance(caught.exception, StopAsyncIteration)
        self.assertEqual(len(self.mon.events), 1)
        self.assertEqual(self.mon.events[0]["status"], "error")

    async def test_async_helper_error_inside_the_with_block(self):
        self.server.script(anthropic_stream(("a", "b"), cut_after=4))
        with self.assertRaises(Exception):
            async with self.client.messages.stream(**ARGS) as stream:
                async for _ in stream:
                    pass
        self.assertEqual(len(self.mon.events), 1)
        self.assertEqual(self.mon.events[0]["status"], "error")


class TestWithTheRealMonitor(unittest.TestCase):
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
        client = instrument_anthropic(client_for(provider), mon)
        self.addCleanup(client.close)
        provider.script(Json(anthropic_message("sure, bob@example.com", input_tokens=10, output_tokens=9, cache_read=60, cache_creation=10)))
        msgs = [{"role": "user", "content": "my card is 4111 1111 1111 1111, mail bob@example.com"}]
        with span("agent", kind="agent", monitor=mon):
            client.messages.create(model="claude-sonnet-5-5", max_tokens=64, messages=msgs)
        self.assertTrue(mon.flush(5))
        self.assertTrue(wait_until(lambda: len(ingest.requests) >= 1))
        events = [e for r in ingest.requests for e in r["body"]["events"]]
        llm = next(e for e in events if e["kind"] == "llm")
        agent = next(e for e in events if e["kind"] == "agent")
        self.assertEqual((llm["input_tokens"], llm["output_tokens"], llm["cached_tokens"]), (80, 9, 60))
        self.assertEqual(llm["parent_id"], agent["span_id"])
        self.assertNotIn("content", llm)
        wire = repr(ingest.requests)
        for raw in ("4111 1111", "bob@example.com", "my card", "sk-ant-test-not-a-real-key"):
            self.assertNotIn(raw, wire)


if __name__ == "__main__":
    unittest.main()
