from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
import warnings
from collections import defaultdict

from _helpers import API_KEY, FakeTransport
from llm_monitor import Monitor, hash_value

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("llm_monitor_demo", os.path.join(HERE, "..", "examples", "demo.py"))
demo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(demo)  # type: ignore[union-attr]


def run(runs=3, **kw):
    t = FakeTransport()
    mon = Monitor(API_KEY, "https://example.test", transport=t)
    demo.run_demo(mon, runs=runs, **kw)
    assert mon.flush(5)
    return t.all_events(), mon


class TestDemoTraffic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.events, cls.mon = run(runs=3)
        cls.traces = defaultdict(list)
        for e in cls.events:
            cls.traces[e["trace_id"]].append(e)

    def test_every_event_is_in_a_trace_and_the_tree_is_consistent(self):
        self.assertEqual(len(self.traces), 3 + 2)
        for tid, evs in self.traces.items():
            ids = {e["span_id"] for e in evs}
            roots = [e for e in evs if "parent_id" not in e]
            self.assertEqual(len(roots), 1, tid)
            self.assertEqual(roots[0]["kind"], "agent")
            for e in evs:
                self.assertIn(e.get("parent_id", e["span_id"]), ids)  # no dangling parent

    def test_covers_the_kinds_and_both_providers(self):
        self.assertEqual({e["kind"] for e in self.events}, {"agent", "llm", "tool", "retrieval"})
        self.assertEqual({e["provider"] for e in self.events if e["kind"] == "llm"}, {"openai", "anthropic"})

    def test_llm_events_have_tokens_ttft_for_streams_and_sane_cache_numbers(self):
        llm = [e for e in self.events if e["kind"] == "llm"]
        self.assertTrue(llm)
        for e in llm:
            self.assertIsInstance(e["input_tokens"], int)
            self.assertIsInstance(e["output_tokens"], int)
            self.assertLessEqual(e.get("cached_tokens", 0), e["input_tokens"])
            self.assertIn("prompt_hash", e)
        streamed = [e for e in llm if "stream" in e.get("tags", [])]
        self.assertTrue(streamed)
        self.assertTrue(all("ttft_ms" in e for e in streamed))

    def test_a_failing_tool_is_recorded_with_redacted_error(self):
        bad = [e for e in self.events if e["status"] == "error"]
        self.assertEqual(len(bad), 1)
        self.assertEqual(bad[0]["name"], "flaky_payments_api")
        self.assertIn("[redacted:email]", bad[0]["error"])
        self.assertNotIn("jane.doe", json.dumps(self.events))

    def test_the_looping_run_repeats_identical_tool_arguments(self):
        loop = next(evs for evs in self.traces.values() if any(e["name"] == "support-agent (looping)" for e in evs))
        searches = [e for e in loop if e["name"] == "search_docs"]
        self.assertEqual(len(searches), demo.LOOP_REPEATS)
        self.assertEqual({e["args_hash"] for e in searches}, {hash_value({"args": ["refund policy"], "kwargs": {}})})
        # a normal run searches once: the loop is what stands out
        normal = next(evs for evs in self.traces.values() if any(e["name"] == "support-agent" and e.get("thread_id") == "demo-conv-0" for e in evs))
        self.assertEqual(len([e for e in normal if e["name"] == "search_docs"]), 1)

    def test_the_loop_is_long_enough_to_be_a_loop(self):
        self.assertGreaterEqual(demo.LOOP_REPEATS, 5)  # Guard's default threshold must be reachable by the demo

    def test_conversations_have_thread_ids(self):
        self.assertTrue({"demo-conv-0", "demo-conv-failing", "demo-conv-loop"} <= {e.get("thread_id") for e in self.events})

    def test_no_prompt_text_leaves_the_process(self):
        wire = json.dumps(self.events)
        for raw in ("Where is my refund", "You are a support agent", "Summarise", "refund policy"):
            self.assertNotIn(raw, wire)

    def test_nothing_was_dropped_or_rejected_by_the_sdk(self):
        s = self.mon.stats
        self.assertEqual((s["events_dropped_queue_full"], s["fields_dropped"], s["errors"]), (0, 0, 0))

    def test_is_deterministic_in_shape_for_a_seed(self):
        a, _ = run(runs=2, seed=11)
        b, _ = run(runs=2, seed=11)
        shape = lambda evs: sorted((e["kind"], e["name"], e.get("input_tokens"), e.get("output_tokens"), e.get("cached_tokens")) for e in evs)
        self.assertEqual(shape(a), shape(b))

    def test_event_count_scales_with_runs(self):
        a, _ = run(runs=1)
        b, _ = run(runs=5)
        self.assertEqual(len(b) - len(a), 4 * 5)  # a normal run is 5 events: agent, search, order, OpenAI call, Anthropic call


class TestCli(unittest.TestCase):
    def call(self, argv, env=None):
        out = io.StringIO()
        old = dict(os.environ)
        try:
            for k in ("LLM_MONITOR_API_KEY", "LLM_MONITOR_URL"):
                os.environ.pop(k, None)
            os.environ.update(env or {})
            with contextlib.redirect_stdout(out), warnings.catch_warnings():
                warnings.simplefilter("ignore")
                code = demo.main(argv)
        finally:
            os.environ.clear()
            os.environ.update(old)
        return code, out.getvalue()

    def test_dry_run_needs_no_configuration_and_writes_jsonl(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "events.jsonl")
            code, text = self.call(["--runs", "2", "--dry-run", "--out", path])
            self.assertEqual(code, 0)
            self.assertIn("nothing was sent", text)
            with open(path, encoding="utf-8") as f:
                lines = [json.loads(line) for line in f]
            self.assertEqual(len(lines), 2 * 5 + 4 + (2 * demo.LOOP_REPEATS + 1))  # 2 normal runs; failing run (agent, order, pay, llm); loop run (agent + search and llm per repeat)
            self.assertTrue(all("event_id" in e for e in lines))

    def test_without_configuration_it_explains_and_exits_2(self):
        code, text = self.call(["--runs", "1"])
        self.assertEqual(code, 2)
        self.assertIn("LLM_MONITOR_API_KEY", text)

    def test_real_run_against_a_local_server(self):
        from _helpers import IngestServer
        with IngestServer() as srv:
            code, text = self.call(["--runs", "2"], env={"LLM_MONITOR_API_KEY": API_KEY, "LLM_MONITOR_URL": srv.url})
            self.assertEqual(code, 0, text)
            sent = [e for r in srv.requests for e in r["body"]["events"]]
            self.assertGreater(len(sent), 10)
            self.assertIn("events were accepted", text)
            self.assertNotIn("dashboard", text)


if __name__ == "__main__":
    unittest.main()
