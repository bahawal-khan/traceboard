from __future__ import annotations

import contextvars
import threading
import time
import unittest
from datetime import datetime, timezone

from llm_monitor import hash_value, observe, set_default_monitor, span, trace
from llm_monitor._context import current_ids
from _fake_openai import StubMonitor


class TestSpan(unittest.TestCase):
    def test_nesting_builds_a_tree_in_one_trace(self):
        mon = StubMonitor()
        with span("run", kind="agent", monitor=mon) as a:
            with span("search", kind="tool", monitor=mon) as b:
                with span("inner", monitor=mon) as c:
                    pass
        by = {e["name"]: e for e in mon.events}
        self.assertEqual([e["name"] for e in mon.events], ["inner", "search", "run"])  # children finish first
        self.assertEqual({e["trace_id"] for e in mon.events}, {a.trace_id})
        self.assertNotIn("parent_id", by["run"])
        self.assertEqual(by["search"]["parent_id"], a.span_id)
        self.assertEqual(by["inner"]["parent_id"], b.span_id)
        self.assertEqual(len({a.span_id, b.span_id, c.span_id}), 3)
        self.assertEqual((by["run"]["kind"], by["search"]["kind"], by["inner"]["kind"]), ("agent", "tool", "custom"))

    def test_context_is_restored_after_exit(self):
        mon = StubMonitor()
        with span("a", monitor=mon):
            with span("b", monitor=mon):
                pass
            self.assertIn("parent_id", current_ids())
        self.assertEqual(current_ids(), {})

    def test_timestamp_is_the_start_and_latency_is_measured(self):
        mon = StubMonitor()
        before = datetime.now(timezone.utc)
        with span("slow", monitor=mon):
            time.sleep(0.05)
        e = mon.events[0]
        self.assertGreaterEqual(e["latency_ms"], 45)
        self.assertLess(abs((e["ts"] - before).total_seconds()), 0.04)

    def test_exception_is_recorded_and_propagates(self):
        mon = StubMonitor()
        with self.assertRaises(KeyError):
            with span("boom", kind="tool", monitor=mon):
                raise KeyError("missing")
        e = mon.events[0]
        self.assertEqual(e["status"], "error")
        self.assertEqual(e["error"], "KeyError: 'missing'")
        self.assertEqual(current_ids(), {})

    def test_keyboard_interrupt_is_not_swallowed(self):
        mon = StubMonitor()
        with self.assertRaises(KeyboardInterrupt):
            with span("x", monitor=mon):
                raise KeyboardInterrupt()
        self.assertEqual(mon.events[0]["status"], "error")

    def test_set_adds_fields(self):
        mon = StubMonitor()
        with span("s", monitor=mon, tags=["a"]) as s:
            s.set(model="m", input_tokens=5)
        e = mon.events[0]
        self.assertEqual((e["model"], e["input_tokens"], e["tags"]), ("m", 5, ["a"]))

    def test_trace_always_starts_a_new_trace(self):
        mon = StubMonitor()
        with span("outer", monitor=mon) as o:
            with trace("fresh", monitor=mon) as t:
                with span("child", monitor=mon):
                    pass
            self.assertEqual(current_ids()["parent_id"], o.span_id)  # outer context restored
        by = {e["name"]: e for e in mon.events}
        self.assertNotEqual(t.trace_id, o.trace_id)
        self.assertNotIn("parent_id", by["fresh"])
        self.assertEqual(by["child"]["trace_id"], t.trace_id)

    def test_thread_id_is_inherited(self):
        mon = StubMonitor()
        with trace("conv", monitor=mon, thread_id="conv-7"):
            with span("turn", monitor=mon):
                pass
        self.assertEqual({e["thread_id"] for e in mon.events}, {"conv-7"})

    def test_no_monitor_is_a_noop_that_still_carries_ids(self):
        set_default_monitor(None)
        with span("a") as a:
            self.assertEqual(current_ids()["parent_id"], a.span_id)
        self.assertIsNone(a.event_id)

    def test_default_monitor_is_used(self):
        mon = StubMonitor()
        set_default_monitor(mon)
        try:
            with span("d"):
                pass
        finally:
            set_default_monitor(None)
        self.assertEqual(len(mon.events), 1)

    def test_disabled_monitor_sends_nothing(self):
        mon = StubMonitor(enabled=False)
        with span("d", monitor=mon):
            pass
        self.assertEqual(mon.events, [])

    def test_a_broken_monitor_never_breaks_the_app(self):
        mon = StubMonitor(raises=True)
        with span("d", monitor=mon):
            pass
        with self.assertRaises(ValueError):
            with span("d", monitor=mon):
                raise ValueError("app error")  # the app's own exception, not the monitor's

    def test_threads_need_copy_context_and_get_it_right(self):
        mon = StubMonitor()
        seen = {}
        with span("main", monitor=mon) as m:
            ctx = contextvars.copy_context()
            plain = threading.Thread(target=lambda: seen.update(plain=current_ids()))
            plain.start(); plain.join()
            copied = threading.Thread(target=lambda: ctx.run(lambda: seen.update(copied=current_ids())))
            copied.start(); copied.join()
        self.assertEqual(seen["plain"], {})  # documented: plain threads do not inherit
        self.assertEqual(seen["copied"]["parent_id"], m.span_id)

    def test_exit_in_another_context_restores_the_parent(self):
        mon = StubMonitor()
        outer = span("outer", monitor=mon)
        outer.__enter__()
        s = span("inner", monitor=mon)
        s.__enter__()
        contextvars.Context().run(lambda: s.__exit__(None, None, None))  # token belongs to another context: must not raise
        outer.__exit__(None, None, None)
        self.assertEqual(len(mon.events), 2)


class TestObserve(unittest.TestCase):
    def test_sync_function(self):
        mon = StubMonitor()

        @observe("add", monitor=mon)
        def add(a, b=1):
            return a + b

        self.assertEqual(add(2, b=3), 5)
        e = mon.events[0]
        self.assertEqual((e["kind"], e["name"]), ("tool", "add"))
        self.assertEqual(e["args"], {"args": [2], "kwargs": {"b": 3}})
        self.assertEqual(add.__name__, "add")

    def test_default_name_and_kind(self):
        mon = StubMonitor()

        @observe(kind="retrieval", monitor=mon)
        def lookup():
            return 1

        lookup()
        self.assertIn("lookup", mon.events[0]["name"])
        self.assertEqual(mon.events[0]["kind"], "retrieval")

    def test_error_propagates(self):
        mon = StubMonitor()

        @observe(monitor=mon)
        def bad():
            raise RuntimeError("no")

        with self.assertRaises(RuntimeError):
            bad()
        self.assertEqual(mon.events[0]["status"], "error")

    def test_hash_args_can_be_turned_off(self):
        mon = StubMonitor()

        @observe(monitor=mon, hash_args=False)
        def f(secret):
            return secret

        f("x")
        self.assertNotIn("args", mon.events[0])

    def test_unhashable_args_do_not_break_the_call(self):
        mon = StubMonitor()

        @observe(monitor=mon)
        def f(x):
            return x

        self.assertEqual(f({1, 2}), {1, 2})  # a set is not JSON: build_event drops the hash, the call is unaffected

    def test_same_arguments_same_hash_for_loop_detection(self):
        from llm_monitor._events import build_event
        mon = StubMonitor()

        @observe(monitor=mon)
        def search(q):
            return q

        search("cats"); search("cats"); search("dogs")
        hashes = [build_event(e)[0]["args_hash"] for e in mon.events]
        self.assertEqual(hashes[0], hashes[1])
        self.assertNotEqual(hashes[0], hashes[2])
        self.assertEqual(hashes[0], hash_value({"args": ["cats"], "kwargs": {}}))


class TestObserveAsync(unittest.IsolatedAsyncioTestCase):
    async def test_async_function_and_nesting(self):
        mon = StubMonitor()

        @observe("fetch", monitor=mon)
        async def fetch(u):
            return u

        async with span("run", monitor=mon) as r:
            self.assertEqual(await fetch("x"), "x")
        by = {e["name"]: e for e in mon.events}
        self.assertEqual(by["fetch"]["parent_id"], r.span_id)

    async def test_async_error(self):
        mon = StubMonitor()

        @observe(monitor=mon)
        async def bad():
            raise ValueError("v")

        with self.assertRaises(ValueError):
            await bad()
        self.assertEqual(mon.events[0]["status"], "error")


if __name__ == "__main__":
    unittest.main()
