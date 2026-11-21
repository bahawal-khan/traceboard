from __future__ import annotations

import gc
import unittest

from llm_monitor import hash_prompt, span
from llm_monitor.integrations.anthropic import instrument_anthropic, uninstrument_anthropic
from _fake_anthropic import (AsyncAnthropic, FakeAnthropic, StubMonitor, ev_block, ev_end, ev_json, ev_start, ev_text, ev_think,
                             message, script, usage, STOP)

MSGS = [{"role": "user", "content": "What is 2+2?"}]


def make(**kw):
    mon = StubMonitor(**kw)
    return instrument_anthropic(FakeAnthropic(), mon), mon


class TestTokenConvention(unittest.TestCase):
    """The server wants input_tokens = TOTAL prompt tokens and cached_tokens = the cached subset of it."""

    def test_input_is_input_plus_cache_read_plus_cache_creation(self):
        client, mon = make()
        client.reply = message("4", use=usage(inp=50, out=7, read=1000, create=200))
        client.messages.create(model="claude-sonnet-5-5", max_tokens=100, messages=MSGS)
        e = mon.events[0]
        self.assertEqual(e["input_tokens"], 1250)
        self.assertEqual(e["cached_tokens"], 1000)  # reads only; creation tokens are NOT cached hits
        self.assertEqual(e["output_tokens"], 7)

    def test_no_cache_fields(self):
        client, mon = make()
        client.reply = message(use=usage(inp=33, out=4))
        client.messages.create(model="m", max_tokens=1, messages=MSGS)
        e = mon.events[0]
        self.assertEqual((e["input_tokens"], e["output_tokens"], e["cached_tokens"]), (33, 4, None))

    def test_cache_creation_only(self):
        client, mon = make()
        client.reply = message(use=usage(inp=5, out=1, create=300))
        client.messages.create(model="m", max_tokens=1, messages=MSGS)
        self.assertEqual(mon.events[0]["input_tokens"], 305)

    def test_missing_usage_is_absent_not_zero(self):
        client, mon = make()
        client.reply.usage = None
        client.messages.create(model="m", max_tokens=1, messages=MSGS)
        self.assertIsNone(mon.events[0]["input_tokens"])
        self.assertIsNone(mon.events[0]["output_tokens"])

    def test_server_cost_model_agrees(self):
        """A 1,250-token prompt with 1,000 cached must not be seen by the server as 2,250 or 250."""
        client, mon = make()
        client.reply = message(use=usage(inp=50, out=0, read=1000, create=200))
        client.messages.create(model="m", max_tokens=1, messages=MSGS)
        e = mon.events[0]
        self.assertLessEqual(e["cached_tokens"], e["input_tokens"])


class TestMessagesCreate(unittest.TestCase):
    def test_basic_event(self):
        client, mon = make()
        client.delay = 0.02
        res = client.messages.create(model="claude-sonnet-5-5", max_tokens=10, messages=MSGS)
        self.assertIs(res, client.reply)
        e = mon.events[0]
        self.assertEqual((e["kind"], e["provider"], e["name"], e["model"]), ("llm", "anthropic", "messages", "claude-sonnet-5-5"))
        self.assertGreaterEqual(e["latency_ms"], 15)
        self.assertEqual(e["prompt"], MSGS)
        self.assertNotIn("content", e)

    def test_system_prompt_is_part_of_the_prompt_hash(self):
        client, mon = make()
        client.messages.create(model="m", max_tokens=1, messages=MSGS, system="Be terse.")
        client.messages.create(model="m", max_tokens=1, messages=MSGS, system="Be verbose.")
        client.messages.create(model="m", max_tokens=1, messages=MSGS)
        h = [hash_prompt(e["prompt"]) for e in mon.events]
        self.assertEqual(len(set(h)), 3)

    def test_arguments_pass_through_untouched(self):
        client, _ = make()
        client.messages.create(model="m", max_tokens=5, messages=MSGS, temperature=0.1)
        self.assertEqual(client.calls[0], {"model": "m", "max_tokens": 5, "messages": MSGS, "temperature": 0.1})

    def test_error_recorded_and_reraised(self):
        client, mon = make()
        client.raises = TimeoutError("slow")
        with self.assertRaises(TimeoutError):
            client.messages.create(model="m", max_tokens=1, messages=MSGS)
        self.assertEqual((mon.events[0]["status"], mon.events[0]["error"]), ("error", "TimeoutError: slow"))

    def test_content_capture_only_when_opted_in(self):
        client, mon = make(capture=True)
        client.reply = message("four")
        client.messages.create(model="m", max_tokens=1, messages=MSGS)
        self.assertEqual(mon.events[0]["content"]["output"], "four")
        client2, mon2 = make()
        client2.messages.create(model="m", max_tokens=1, messages=MSGS)
        self.assertNotIn("content", mon2.events[0])

    def test_broken_and_disabled_monitors(self):
        client, _ = make(raises=True)
        self.assertIs(client.messages.create(model="m", max_tokens=1, messages=MSGS), client.reply)
        client, mon = make(enabled=False)
        client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True)
        self.assertEqual(client.calls[0], {"model": "m", "max_tokens": 1, "messages": MSGS, "stream": True})
        self.assertEqual(mon.events, [])

    def test_idempotent_and_reversible(self):
        mon = StubMonitor()
        client = FakeAnthropic()
        orig_create, orig_stream = client.messages.create, client.messages.stream
        instrument_anthropic(client, mon)
        wrapped = client.messages.create
        instrument_anthropic(client, mon)
        self.assertIs(client.messages.create, wrapped)
        client.messages.create(model="m", max_tokens=1, messages=MSGS)
        self.assertEqual(len(mon.events), 1)
        uninstrument_anthropic(client)
        self.assertEqual((client.messages.create, client.messages.stream), (orig_create, orig_stream))

    def test_child_of_current_span(self):
        client, mon = make()
        with span("agent", kind="agent", monitor=mon) as s:
            client.messages.create(model="m", max_tokens=1, messages=MSGS)
        llm = mon.events[0]
        self.assertEqual((llm["trace_id"], llm["parent_id"]), (s.trace_id, s.span_id))


class TestCreateStream(unittest.TestCase):
    def test_tokens_from_start_and_delta_and_ttft(self):
        client, mon = make()
        client.events = script(["Hel", "lo"], use=usage(inp=40, out=1, read=500, create=60), out=17)
        client.delay = 0.03
        out = list(client.messages.create(model="claude-sonnet-5-5", max_tokens=9, messages=MSGS, stream=True))
        self.assertEqual(len(out), len(client.events))  # every event reaches the caller, nothing hidden or injected
        self.assertNotIn("stream_options", client.calls[0])
        e = mon.events[0]
        self.assertEqual((e["input_tokens"], e["cached_tokens"], e["output_tokens"]), (600, 500, 17))
        self.assertEqual(e["tags"], ["stream"])
        # message_start 30 ms, block_start 60 ms, first text delta 90 ms
        self.assertGreaterEqual(e["ttft_ms"], 80)
        self.assertGreaterEqual(e["latency_ms"], e["ttft_ms"])

    def test_message_delta_replaces_not_adds_and_keeps_omitted_fields(self):
        client, mon = make()
        client.events = [ev_start(use=usage(10, 1, read=7)), ev_block(), ev_text("a"), ev_end(30), STOP]
        list(client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True))
        e = mon.events[0]
        self.assertEqual((e["input_tokens"], e["cached_tokens"], e["output_tokens"]), (17, 7, 30))  # not 31, input kept

    def test_message_delta_may_carry_updated_input_counts(self):
        client, mon = make()
        client.events = [ev_start(use=usage(10, 1)), ev_block(), ev_text("a"), ev_end(5, inp=12, read=3), STOP]
        list(client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True))
        e = mon.events[0]
        self.assertEqual((e["input_tokens"], e["cached_tokens"]), (15, 3))

    def test_empty_first_deltas_do_not_count_as_first_token(self):
        client, mon = make()
        client.events = [ev_start(), ev_block(), ev_text(""), ev_json(""), ev_text("x"), ev_end(), STOP]
        client.delay = 0.02
        list(client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True))
        self.assertGreaterEqual(mon.events[0]["ttft_ms"], 70)  # the 4th event, not the 3rd

    def test_thinking_and_tool_input_count_as_first_token(self):
        for first in (ev_think("hm"), ev_json('{"q"')):
            client, mon = make()
            client.events = [ev_start(), first, ev_end(), STOP]
            list(client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True))
            self.assertIsNotNone(mon.events[0].get("ttft_ms"))

    def test_tool_use_block_start_counts(self):
        client, mon = make()
        client.events = [ev_start(), ev_block("tool_use"), ev_end(stop="tool_use"), STOP]
        list(client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True))
        self.assertIsNotNone(mon.events[0].get("ttft_ms"))

    def test_text_block_start_alone_is_not_a_token(self):
        client, mon = make()
        client.events = [ev_start(), ev_block("text"), ev_end(), STOP]
        list(client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True))
        self.assertNotIn("ttft_ms", mon.events[0])

    def test_abandoned_stream_reports_once_as_incomplete(self):
        client, mon = make()
        s = client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True)
        next(s); next(s); next(s)
        s.close(); s.close()
        del s
        gc.collect()
        self.assertEqual(len(mon.events), 1)
        self.assertEqual(mon.events[0]["tags"], ["stream", "incomplete"])
        self.assertEqual(mon.events[0]["input_tokens"], 10)  # message_start had arrived

    def test_complete_stream_is_reported_once(self):
        client, mon = make()
        s = client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True)
        list(s); s.close(); del s; gc.collect()
        self.assertEqual(len(mon.events), 1)
        self.assertNotIn("incomplete", mon.events[0]["tags"])

    def test_with_block(self):
        client, mon = make()
        with client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True) as s:
            for _ in s:
                pass
        self.assertEqual(len(mon.events), 1)

    def test_error_mid_stream(self):
        client, mon = make()
        client.fail_at = 3
        with self.assertRaises(ConnectionError):
            list(client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True))
        self.assertEqual(mon.events[0]["status"], "error")

    def test_streamed_content_only_with_opt_in(self):
        client, mon = make(capture=True)
        list(client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True))
        self.assertEqual(mon.events[0]["content"]["output"], "Hello")
        client, mon = make()
        s = client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True)
        list(s)
        self.assertEqual(s._call.output_parts, [])


    def test_only_text_deltas_are_captured_as_output(self):
        client, mon = make(capture=True)
        client.events = [ev_start(), ev_think("secret reasoning"), ev_json('{"q":1}'), ev_text("answer"), ev_end(), STOP]
        list(client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True))
        self.assertEqual(mon.events[0]["content"]["output"], "answer")


class TestStreamHelper(unittest.TestCase):
    def test_the_managers_own_exit_result_is_preserved(self):
        client, mon = make()
        client.suppress = True  # a context manager may suppress the exception; the wrapper must not change that
        with client.messages.stream(model="m", max_tokens=5, messages=MSGS):
            raise ValueError("suppressed by the manager")
        self.assertEqual(mon.events[0]["status"], "error")

    def test_iterating_the_stream_gives_tokens_and_ttft(self):
        client, mon = make()
        client.events = script(["Hel", "lo"], use=usage(inp=40, out=1, read=500, create=60), out=17)
        client.delay = 0.02
        with client.messages.stream(model="m", max_tokens=5, messages=MSGS) as s:
            events = list(s)
        self.assertTrue(any(e.type == "text" for e in events))
        e = mon.events[0]
        self.assertEqual((e["input_tokens"], e["cached_tokens"], e["output_tokens"]), (600, 500, 17))
        self.assertEqual(e["tags"], ["stream"])
        self.assertGreaterEqual(e["ttft_ms"], 55)
        self.assertEqual(len(mon.events), 1)

    def test_text_stream_and_get_final_message_still_work(self):
        client, mon = make()
        with client.messages.stream(model="m", max_tokens=5, messages=MSGS) as s:
            self.assertEqual("".join(s.text_stream), "Hello")
            final = s.get_final_message()
        self.assertEqual(final.usage.output_tokens, 20)
        e = mon.events[0]
        self.assertEqual((e["input_tokens"], e["output_tokens"]), (10, 20))  # from the final snapshot
        self.assertNotIn("incomplete", e["tags"])
        self.assertNotIn("ttft_ms", e)  # documented: text_stream bypasses the wrapper, so no TTFT

    def test_abandoned_helper_stream_is_incomplete(self):
        client, mon = make()
        with client.messages.stream(model="m", max_tokens=5, messages=MSGS) as s:
            for _ in s:
                break
        self.assertEqual(len(mon.events), 1)
        self.assertEqual(mon.events[0]["tags"], ["stream", "incomplete"])

    def test_error_inside_the_with_block(self):
        client, mon = make()
        with self.assertRaises(ValueError):
            with client.messages.stream(model="m", max_tokens=5, messages=MSGS) as s:
                next(iter(s))
                raise ValueError("app bug")
        self.assertEqual((mon.events[0]["status"], mon.events[0]["error"]), ("error", "ValueError: app bug"))

    def test_stream_error_from_the_network(self):
        client, mon = make()
        client.fail_at = 2
        with self.assertRaises(ConnectionError):
            with client.messages.stream(model="m", max_tokens=5, messages=MSGS) as s:
                list(s)
        self.assertEqual(mon.events[0]["status"], "error")

    def test_error_creating_the_manager(self):
        client, mon = make()
        client.raises = ConnectionError("refused")
        with self.assertRaises(ConnectionError):
            client.messages.stream(model="m", max_tokens=5, messages=MSGS)
        self.assertEqual(mon.events[0]["status"], "error")

    def test_helper_content_capture(self):
        client, mon = make(capture=True)
        with client.messages.stream(model="m", max_tokens=5, messages=MSGS) as s:
            s.get_final_message()
        self.assertEqual(mon.events[0]["content"]["output"], "Hello")

    def test_manager_exit_is_forwarded(self):
        client, mon = make()
        mgr = client.messages.stream(model="m", max_tokens=5, messages=MSGS)
        with mgr:
            pass
        self.assertTrue(mgr._inner.exited)

    def test_disabled_monitor_passthrough(self):
        client, mon = make(enabled=False)
        with client.messages.stream(model="m", max_tokens=5, messages=MSGS) as s:
            self.assertEqual("".join(s.text_stream), "Hello")
        self.assertEqual(mon.events, [])


class TestAsync(unittest.IsolatedAsyncioTestCase):
    def make(self, **kw):
        mon = StubMonitor(**kw)
        return instrument_anthropic(AsyncAnthropic(), mon), mon

    async def test_async_create(self):
        client, mon = self.make()
        client.reply = message(use=usage(5, 2, read=100, create=10))
        res = await client.messages.create(model="m", max_tokens=1, messages=MSGS)
        self.assertIs(res, client.reply)
        self.assertEqual((mon.events[0]["input_tokens"], mon.events[0]["cached_tokens"]), (115, 100))

    async def test_async_error(self):
        client, mon = self.make()
        client.raises = ValueError("x")
        with self.assertRaises(ValueError):
            await client.messages.create(model="m", max_tokens=1, messages=MSGS)
        self.assertEqual(mon.events[0]["status"], "error")

    async def test_async_create_stream(self):
        client, mon = self.make()
        client.delay = 0.02
        s = await client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True)
        out = [e async for e in s]
        self.assertEqual(len(out), len(client.events))
        e = mon.events[0]
        self.assertEqual((e["input_tokens"], e["output_tokens"]), (10, 20))
        self.assertGreaterEqual(e["ttft_ms"], 55)

    async def test_async_create_stream_abandoned(self):
        client, mon = self.make()
        s = await client.messages.create(model="m", max_tokens=1, messages=MSGS, stream=True)
        async for _ in s:
            break
        await s.close()
        await s.close()
        self.assertEqual(len(mon.events), 1)
        self.assertIn("incomplete", mon.events[0]["tags"])

    async def test_async_helper_stream(self):
        client, mon = self.make()
        client.delay = 0.02
        async with client.messages.stream(model="m", max_tokens=1, messages=MSGS) as s:
            async for _ in s:
                pass
        e = mon.events[0]
        self.assertEqual((e["input_tokens"], e["output_tokens"]), (10, 20))
        self.assertIsNotNone(e["ttft_ms"])
        self.assertEqual(len(mon.events), 1)

    async def test_async_helper_get_final_message(self):
        client, mon = self.make()
        async with client.messages.stream(model="m", max_tokens=1, messages=MSGS) as s:
            final = await s.get_final_message()
        self.assertEqual(final.usage.output_tokens, 20)
        self.assertEqual(mon.events[0]["output_tokens"], 20)

    async def test_async_helper_error(self):
        client, mon = self.make()
        with self.assertRaises(KeyError):
            async with client.messages.stream(model="m", max_tokens=1, messages=MSGS):
                raise KeyError("k")
        self.assertEqual(mon.events[0]["status"], "error")


class TestRawCallsPassThrough(unittest.TestCase):
    def test_marked_calls_are_not_recorded_and_arguments_are_untouched(self):
        client, mon = make()
        client.messages.create(model="m", max_tokens=5, messages=MSGS, extra_headers={"X-Stainless-Raw-Response": "raw"})
        self.assertEqual(mon.events, [])
        self.assertEqual(client.calls[-1]["extra_headers"], {"X-Stainless-Raw-Response": "raw"})
        client.messages.create(model="m", max_tokens=5, messages=MSGS, extra_headers={"X-Mine": "1"})
        self.assertEqual(len(mon.events), 1)


class TestWithRealMonitor(unittest.TestCase):
    def test_what_is_sent_is_hashed_and_totalled(self):
        from _helpers import API_KEY, FakeTransport
        from llm_monitor import Monitor
        t = FakeTransport()
        mon = Monitor(API_KEY, "https://example.test", transport=t)
        client = instrument_anthropic(FakeAnthropic(), mon)
        msgs = [{"role": "user", "content": "call me on +44 7700 900123 or bob@example.com"}]
        client.reply = message("ok bob@example.com", use=usage(20, 3, read=80, create=0))
        client.messages.create(model="claude-sonnet-5-5", max_tokens=5, messages=msgs, system="be nice")
        self.assertTrue(mon.flush(5))
        (e,) = t.all_events()
        self.assertEqual((e["input_tokens"], e["cached_tokens"], e["output_tokens"]), (100, 80, 3))
        self.assertEqual(e["prompt_hash"], hash_prompt({"system": "be nice", "messages": msgs}))
        wire = repr(e)
        for raw in ("bob@example.com", "7700", "be nice"):
            self.assertNotIn(raw, wire)


if __name__ == "__main__":
    unittest.main()
