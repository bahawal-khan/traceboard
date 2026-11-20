from __future__ import annotations

import gc
import unittest

from llm_monitor import hash_prompt, span
from llm_monitor.integrations.openai import instrument_openai, uninstrument_openai
from _fake_openai import AsyncOpenAI, FakeOpenAI, StubMonitor, chunk, response, script, usage

MSGS = [{"role": "user", "content": "What is 2+2?"}]


def make(**kw):
    mon = StubMonitor(**kw)
    client = instrument_openai(FakeOpenAI(), mon)
    return client, mon


class TestNonStreaming(unittest.TestCase):
    def test_records_tokens_model_latency_and_prompt_hash(self):
        client, mon = make()
        client.reply = response("4", model="gpt-4o-2024-08-06", use=usage(1200, 30, cached=1024))
        client.delay = 0.02
        res = client.chat.completions.create(model="gpt-4o", messages=MSGS)
        self.assertIs(res, client.reply)  # the caller gets the very object the provider returned
        (e,) = mon.events
        self.assertEqual((e["kind"], e["provider"], e["name"]), ("llm", "openai", "chat.completions"))
        self.assertEqual(e["model"], "gpt-4o-2024-08-06")  # the model the API reports, not the alias asked for
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (1200, 30, 1024))
        self.assertGreaterEqual(e["latency_ms"], 15)
        self.assertEqual(e["prompt"], MSGS)  # raw; build_event hashes it and keeps nothing
        self.assertNotIn("ttft_ms", e)
        self.assertNotIn("status", e)
        self.assertNotIn("content", e)

    def test_missing_usage_is_just_absent(self):
        client, mon = make()
        client.reply = response()
        client.reply.usage = None
        client.chat.completions.create(model="m", messages=MSGS)
        self.assertIsNone(mon.events[0]["input_tokens"])

    def test_error_is_recorded_and_reraised(self):
        client, mon = make()
        client.raises = TimeoutError("upstream timed out")
        with self.assertRaises(TimeoutError):
            client.chat.completions.create(model="m", messages=MSGS)
        (e,) = mon.events
        self.assertEqual(e["status"], "error")
        self.assertEqual(e["error"], "TimeoutError: upstream timed out")
        self.assertEqual(e["model"], "m")

    def test_arguments_pass_through_untouched(self):
        client, _ = make()
        client.chat.completions.create(model="m", messages=MSGS, temperature=0.2, user="u1")
        self.assertEqual(client.calls[0], {"model": "m", "messages": MSGS, "temperature": 0.2, "user": "u1"})

    def test_broken_monitor_never_breaks_the_call(self):
        client, mon = make(raises=True)
        res = client.chat.completions.create(model="m", messages=MSGS)
        self.assertIs(res, client.reply)

    def test_disabled_monitor_is_a_pure_passthrough(self):
        client, mon = make(enabled=False)
        list(client.chat.completions.create(model="m", messages=MSGS, stream=True))
        self.assertEqual(client.calls[0], {"model": "m", "messages": MSGS, "stream": True})  # no stream_options injected
        self.assertEqual(mon.events, [])

    def test_content_only_when_capture_is_on(self):
        client, mon = make(capture=True)
        client.reply = response("four")
        client.chat.completions.create(model="m", messages=MSGS)
        c = mon.events[0]["content"]
        self.assertIn("What is 2+2?", c["input"])
        self.assertEqual(c["output"], "four")

    def test_idempotent_and_reversible(self):
        mon = StubMonitor()
        client = FakeOpenAI()
        original = client.chat.completions.create
        instrument_openai(client, mon)
        wrapped = client.chat.completions.create
        instrument_openai(client, mon)
        self.assertIs(client.chat.completions.create, wrapped)  # not wrapped twice
        client.chat.completions.create(model="m", messages=MSGS)
        self.assertEqual(len(mon.events), 1)
        uninstrument_openai(client)
        self.assertEqual(client.chat.completions.create, original)

    def test_rejects_a_client_without_chat_completions(self):
        with self.assertRaises(Exception):
            instrument_openai(object(), StubMonitor())


class TestTraceContext(unittest.TestCase):
    def test_llm_call_becomes_a_child_of_the_current_span(self):
        client, mon = make()
        with span("agent", kind="agent", monitor=mon) as s:
            client.chat.completions.create(model="m", messages=MSGS)
        llm, agent = mon.events
        self.assertEqual(llm["trace_id"], s.trace_id)
        self.assertEqual(llm["parent_id"], s.span_id)
        self.assertTrue(llm["span_id"])
        self.assertNotEqual(llm["span_id"], s.span_id)
        self.assertEqual(agent["span_id"], s.span_id)

    def test_no_context_means_no_trace_ids(self):
        client, mon = make()
        client.chat.completions.create(model="m", messages=MSGS)
        for k in ("trace_id", "parent_id", "span_id"):
            self.assertNotIn(k, mon.events[0])


class TestStreaming(unittest.TestCase):
    def test_usage_injected_hidden_and_ttft_skips_the_role_chunk(self):
        client, mon = make()
        client.chunks = script(["Hel", "lo"], use=usage(50, 7, cached=10))
        client.delay = 0.03
        out = list(client.chat.completions.create(model="gpt-4o", messages=MSGS, stream=True))
        self.assertEqual(client.calls[0]["stream_options"], {"include_usage": True})
        self.assertEqual(len(out), 3)  # role chunk + 2 content chunks; the injected usage-only chunk is hidden
        self.assertTrue(all(c.choices for c in out))
        (e,) = mon.events
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (50, 7, 10))
        self.assertEqual(e["tags"], ["stream"])
        # role chunk arrives after ~30 ms, first content after ~60 ms: TTFT must not be the role chunk's time
        self.assertGreaterEqual(e["ttft_ms"], 50)
        self.assertGreaterEqual(e["latency_ms"], e["ttft_ms"])
        self.assertGreaterEqual(e["latency_ms"], 85)  # four chunks at 30 ms

    def test_callers_own_stream_options_are_respected(self):
        client, mon = make()
        out = list(client.chat.completions.create(model="m", messages=MSGS, stream=True, stream_options={"include_usage": True}))
        self.assertEqual(client.calls[0]["stream_options"], {"include_usage": True})
        self.assertEqual(len(out), 4)  # they asked for the usage chunk, they get it
        self.assertEqual(mon.events[0]["input_tokens"], 100)

    def test_caller_who_disabled_usage_gets_unchanged_stream(self):
        client, mon = make()
        client.chunks = script(["a"], with_usage=False)
        list(client.chat.completions.create(model="m", messages=MSGS, stream=True, stream_options={"include_usage": False}))
        self.assertEqual(client.calls[0]["stream_options"], {"include_usage": False})
        self.assertIsNone(mon.events[0]["input_tokens"])

    def test_tool_call_chunk_counts_as_first_token(self):
        client, mon = make()
        client.chunks = [chunk(role=True), chunk(tool=True), chunk(empty=True, use=usage())]
        list(client.chat.completions.create(model="m", messages=MSGS, stream=True))
        self.assertIsNotNone(mon.events[0]["ttft_ms"])

    def test_stream_without_content_has_no_ttft(self):
        client, mon = make()
        client.chunks = [chunk(role=True), chunk(empty=True, use=usage())]
        list(client.chat.completions.create(model="m", messages=MSGS, stream=True))
        self.assertNotIn("ttft_ms", mon.events[0])

    def test_one_event_even_if_closed_after_exhaustion(self):
        client, mon = make()
        s = client.chat.completions.create(model="m", messages=MSGS, stream=True)
        list(s)
        s.close()
        del s
        gc.collect()
        self.assertEqual(len(mon.events), 1)
        self.assertNotIn("incomplete", mon.events[0]["tags"])

    def test_abandoned_stream_is_recorded_once_as_incomplete(self):
        client, mon = make()
        s = client.chat.completions.create(model="m", messages=MSGS, stream=True)
        next(s)
        next(s)
        s.close()
        s.close()
        self.assertEqual(len(mon.events), 1)
        self.assertEqual(mon.events[0]["tags"], ["stream", "incomplete"])
        self.assertIsNotNone(mon.events[0]["ttft_ms"])
        self.assertTrue(s._inner.closed)

    def test_garbage_collected_stream_still_reports(self):
        client, mon = make()
        s = client.chat.completions.create(model="m", messages=MSGS, stream=True)
        next(s)
        del s
        gc.collect()
        self.assertEqual(len(mon.events), 1)
        self.assertIn("incomplete", mon.events[0]["tags"])

    def test_context_manager_usage(self):
        client, mon = make()
        with client.chat.completions.create(model="m", messages=MSGS, stream=True) as s:
            for _ in s:
                pass
        self.assertEqual(len(mon.events), 1)
        self.assertEqual(mon.events[0]["output_tokens"], 20)

    def test_break_inside_with_block(self):
        client, mon = make()
        with client.chat.completions.create(model="m", messages=MSGS, stream=True) as s:
            for _ in s:
                break
        self.assertEqual(len(mon.events), 1)
        self.assertIn("incomplete", mon.events[0]["tags"])

    def test_error_mid_stream_is_recorded_and_reraised(self):
        client, mon = make()
        client.fail_at = 2
        with self.assertRaises(ConnectionError):
            list(client.chat.completions.create(model="m", messages=MSGS, stream=True))
        (e,) = mon.events
        self.assertEqual(e["status"], "error")
        self.assertIn("ConnectionError", e["error"])
        self.assertIsNotNone(e["ttft_ms"] if "ttft_ms" in e else 1)

    def test_error_creating_stream(self):
        client, mon = make()
        client.raises = ConnectionError("refused")
        with self.assertRaises(ConnectionError):
            client.chat.completions.create(model="m", messages=MSGS, stream=True)
        self.assertEqual(mon.events[0]["status"], "error")

    def test_attributes_of_the_real_stream_are_reachable(self):
        client, _ = make()
        s = client.chat.completions.create(model="m", messages=MSGS, stream=True)
        self.assertEqual(s.response.status_code, 200)
        with self.assertRaises(AttributeError):
            s.nope

    def test_streamed_text_is_not_even_buffered_without_opt_in(self):
        client, mon = make(capture=False)
        s = client.chat.completions.create(model="m", messages=MSGS, stream=True)
        list(s)
        self.assertEqual(s._call.output_parts, [])
        self.assertNotIn("content", mon.events[0])

    def test_streamed_content_capture(self):
        client, mon = make(capture=True)
        list(client.chat.completions.create(model="m", messages=MSGS, stream=True))
        self.assertEqual(mon.events[0]["content"]["output"], "Hello")


class TestAsync(unittest.IsolatedAsyncioTestCase):
    def make(self, **kw):
        mon = StubMonitor(**kw)
        return instrument_openai(AsyncOpenAI(), mon), mon

    async def test_async_call(self):
        client, mon = self.make()
        client.reply = response("x", use=usage(10, 2, cached=4))
        res = await client.chat.completions.create(model="m", messages=MSGS)
        self.assertIs(res, client.reply)
        e = mon.events[0]
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (10, 2, 4))

    async def test_async_error(self):
        client, mon = self.make()
        client.raises = ValueError("bad")
        with self.assertRaises(ValueError):
            await client.chat.completions.create(model="m", messages=MSGS)
        self.assertEqual(mon.events[0]["status"], "error")

    async def test_async_stream(self):
        client, mon = self.make()
        client.delay = 0.02
        s = await client.chat.completions.create(model="m", messages=MSGS, stream=True)
        out = [c async for c in s]
        self.assertEqual(len(out), 3)
        e = mon.events[0]
        self.assertEqual(e["output_tokens"], 20)
        self.assertGreaterEqual(e["ttft_ms"], 30)
        self.assertEqual(e["tags"], ["stream"])
        self.assertEqual(client.calls[0]["stream_options"], {"include_usage": True})

    async def test_async_stream_context_and_early_exit(self):
        client, mon = self.make()
        async with await client.chat.completions.create(model="m", messages=MSGS, stream=True) as s:
            async for _ in s:
                break
        self.assertEqual(len(mon.events), 1)
        self.assertIn("incomplete", mon.events[0]["tags"])

    async def test_async_stream_error(self):
        client, mon = self.make()
        client.fail_at = 1
        s = await client.chat.completions.create(model="m", messages=MSGS, stream=True)
        with self.assertRaises(ConnectionError):
            async for _ in s:
                pass
        self.assertEqual(mon.events[0]["status"], "error")

    async def test_async_calls_in_parallel_tasks_get_their_own_parent(self):
        import asyncio
        client, mon = self.make()

        async def run(name):
            async with span(name, monitor=mon):
                await client.chat.completions.create(model="m", messages=MSGS)

        await asyncio.gather(run("a"), run("b"))
        spans = {e["name"]: e for e in mon.events if e.get("name") in ("a", "b")}
        llms = [e for e in mon.events if e["name"] == "chat.completions"]
        self.assertEqual({l["parent_id"] for l in llms}, {spans["a"]["span_id"], spans["b"]["span_id"]})
        self.assertNotEqual(spans["a"]["trace_id"], spans["b"]["trace_id"])


if __name__ == "__main__":
    unittest.main()


class TestWithRealMonitor(unittest.TestCase):
    """The wrapper with the real Monitor: what reaches the transport is what the server accepts, and nothing raw leaks."""

    def run_case(self, **options):
        from _helpers import API_KEY, FakeTransport
        from llm_monitor import Monitor
        t = FakeTransport()
        mon = Monitor(API_KEY, "https://example.test", transport=t, **options)
        client = instrument_openai(FakeOpenAI(), mon)
        return client, mon, t

    def test_default_events_are_hashed_and_carry_no_prompt_text(self):
        client, mon, t = self.run_case()
        msgs = [{"role": "user", "content": "my card is 4111 1111 1111 1111, mail bob@example.com"}]
        client.reply = response("sure, bob@example.com", use=usage(80, 9, cached=16))
        with span("agent", kind="agent", monitor=mon):
            client.chat.completions.create(model="gpt-4o", messages=msgs)
        self.assertTrue(mon.flush(5))
        events = t.all_events()
        llm = next(e for e in events if e["kind"] == "llm")
        self.assertEqual(llm["prompt_hash"], hash_prompt(msgs))
        self.assertEqual((llm["input_tokens"], llm["output_tokens"], llm["cached_tokens"]), (80, 9, 16))
        self.assertNotIn("content", llm)
        wire = repr(events)
        for raw in ("4111", "bob@example.com", "my card"):
            self.assertNotIn(raw, wire)
        agent = next(e for e in events if e["kind"] == "agent")
        self.assertEqual(llm["parent_id"], agent["span_id"])
        self.assertEqual(llm["trace_id"], agent["trace_id"])

    def test_opt_in_content_is_redacted_before_it_is_queued(self):
        client, mon, t = self.run_case(capture_content=True)
        client.reply = response("reach me at bob@example.com")
        client.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": "hi from alice@example.com"}])
        self.assertTrue(mon.flush(5))
        c = t.all_events()[0]["content"]
        self.assertNotIn("@example.com", c["input"] + c["output"])
        self.assertIn("[redacted:email]", c["input"])
        self.assertIn("[redacted:email]", c["output"])
        self.assertEqual(mon.captures_content, True)

    def test_disabled_real_monitor_changes_nothing(self):
        from llm_monitor import Monitor
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            mon = Monitor(None, None)  # no key: the SDK disables itself
        client = instrument_openai(FakeOpenAI(), mon)
        list(client.chat.completions.create(model="m", messages=MSGS, stream=True))
        self.assertNotIn("stream_options", client.calls[0])
