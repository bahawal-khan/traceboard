"""Retries, backoff, Retry-After, 413 handling, poison isolation, outage survival, flush hints, byte splitting, gzip."""
import socket
import threading
import time
import unittest

from llm_monitor import Monitor
from _helpers import API_KEY, FakeTransport, IngestServer, ScriptedTransport, fail_result, ok_result, wait_until

URL = "https://monitor.example.com"


def make(transport, **options):
    options.setdefault("min_flush_interval_ms", 20)
    options.setdefault("flush_interval_ms", 60_000)  # the thread stays idle unless a test wants it
    options.setdefault("retry_base_s", 0.01)
    options.setdefault("retry_max_s", 0.05)
    return Monitor(API_KEY, URL, transport=transport, **options)


def core(mon):
    return mon._holder.core


def drain(mon, rounds=200):
    """Explicit flushes (which ignore the backoff gate) until the queue is empty."""
    for _ in range(rounds):
        if mon.flush(timeout=5) and mon._queue_len() == 0:
            return True
    return False


class TestBackoffFormula(unittest.TestCase):
    def test_exponential_with_equal_jitter_and_a_cap(self):
        mon = make(FakeTransport(), retry_base_s=1.0, retry_max_s=30.0)
        c = core(mon)
        c.rand = lambda: 0.0  # the lowest the jitter can go: half the ceiling
        self.assertEqual([c.backoff_delay(n, None) for n in range(1, 8)], [0.5, 1.0, 2.0, 4.0, 8.0, 15.0, 15.0])
        c.rand = lambda: 1.0  # the highest: the full ceiling
        self.assertEqual([c.backoff_delay(n, None) for n in range(1, 8)], [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0])
        mon.shutdown(0)

    def test_the_jitter_is_really_random_within_bounds(self):
        mon = make(FakeTransport(), retry_base_s=1.0, retry_max_s=30.0)
        values = [core(mon).backoff_delay(3, None) for _ in range(200)]
        self.assertTrue(all(2.0 <= v <= 4.0 for v in values))
        self.assertGreater(len(set(values)), 100)
        self.assertNotIn(core(mon).backoff_delay(10_000, None), (float("inf"),))  # a huge failure count cannot overflow
        mon.shutdown(0)

    def test_retry_after_raises_the_delay_but_is_capped(self):
        mon = make(FakeTransport(), retry_base_s=1.0, retry_max_s=30.0, max_retry_after_s=60.0)
        c = core(mon)
        c.rand = lambda: 0.0
        self.assertEqual(c.backoff_delay(1, 20.0), 20.0)  # larger than the computed 0.5
        self.assertEqual(c.backoff_delay(1, 0.1), 0.5)  # smaller: the computed backoff wins
        self.assertEqual(c.backoff_delay(1, 86_400.0), 60.0)  # the server's "until UTC midnight" is capped
        self.assertEqual(c.backoff_delay(1, None), 0.5)
        mon.shutdown(0)


class TestClassification(unittest.TestCase):
    def run_with_status(self, status, retry_after=None):
        t = ScriptedTransport(lambda events: fail_result(status, retry_after))
        mon = make(t)
        for i in range(3):
            mon.track(name="e%d" % i)
        mon.flush(timeout=5)
        stats = mon.stats
        mon.shutdown(0)
        return stats

    def test_transient_failures_keep_the_events(self):
        for status in (None, 408, 429, 502, 503, 504):
            s = self.run_with_status(status)
            self.assertEqual((s["queue_size"], s["events_failed"], s["batches_requeued"]), (3, 0, 1), status)
            self.assertEqual(s["consecutive_failures"], 1, status)

    def test_a_plain_500_is_also_retried_for_a_batch_but_isolated(self):
        s = self.run_with_status(500)
        self.assertEqual((s["queue_size"], s["events_failed"]), (3, 0))
        self.assertEqual(s["batch_cap"], 1)  # halved from 3: isolating a possible poison event

    def test_permanent_failures_drop_the_batch(self):
        for status in (400, 404, 405, 415, 422, 301, 302, 307):
            s = self.run_with_status(status)
            self.assertEqual((s["queue_size"], s["events_failed"], s["batches_requeued"]), (0, 3, 0), status)

    def test_rejected_credentials_drop_the_batch_and_pause_sending_with_a_warning(self):
        for status in (401, 403):
            t = ScriptedTransport(lambda events, st=status: fail_result(st))
            mon = make(t, retry_max_s=30.0)
            mon.track(name="x")
            with self.assertLogs("llm_monitor", level="WARNING") as logs:
                mon.flush(timeout=5)
            self.assertEqual(mon.stats["events_failed"], 1)
            self.assertGreater(core(mon).retry_at - time.monotonic(), 20)  # the background thread will not hammer the server
            self.assertNotIn(API_KEY, "\n".join(logs.output))
            mon.shutdown(0)

    def test_success_resets_the_failure_state(self):
        answers = [fail_result(503), fail_result(503), None]
        t = ScriptedTransport(lambda events: answers.pop(0) if answers[0] is not None else ok_result(events))
        mon = make(t)
        mon.track(name="x")
        mon.flush(timeout=5)
        mon.flush(timeout=5)
        self.assertEqual(mon.stats["consecutive_failures"], 2)
        mon.flush(timeout=5)
        s = mon.stats
        self.assertEqual((s["consecutive_failures"], s["events_sent"], s["queue_size"]), (0, 1, 0))
        self.assertEqual(core(mon).retry_at, 0.0)
        mon.shutdown(0)

    def test_retry_after_from_the_server_is_capped_before_it_gates_the_thread(self):
        t = ScriptedTransport(lambda events: fail_result(429, 3600.0))
        mon = make(t, max_retry_after_s=0.3)
        mon.track(name="x")
        mon.flush(timeout=5)
        wait = core(mon).retry_at - time.monotonic()
        self.assertTrue(0.2 < wait <= 0.31, wait)
        mon.shutdown(0)


def quota_body(**over):
    body = {"error": "quota_exceeded", "limit": "events", "requestId": "r-1"}
    body.update(over)
    return body


def gate_after_one_failure(result, **options):
    """Runs one failing send and returns how many seconds the background thread is told to wait."""
    t = ScriptedTransport(lambda events: result)
    mon = make(t, **options)
    mon.track(name="x")
    mon.flush(timeout=5)
    wait = core(mon).retry_at - time.monotonic()
    mon.shutdown(0)
    return wait


def failing(status, retry_after, body):
    r = fail_result(status, retry_after)
    r.body = body
    return r


class TestQuotaRetryAfter(unittest.TestCase):
    """A daily quota answers Retry-After until UTC midnight. Retrying every minute or two all day would cost one server
    invocation per retry per project, so ONLY quota_exceeded is honoured up to max_quota_retry_after_s (900 s);
    every other transient error keeps the 60 s cap."""

    def test_quota_exceeded_waits_up_to_the_quota_cap_and_not_more(self):
        wait = gate_after_one_failure(failing(429, 43_200.0, quota_body()), retry_max_s=30.0)  # "12 hours" asked for
        self.assertTrue(899 < wait <= 900.5, wait)

    def test_quota_exceeded_with_a_shorter_retry_after_waits_exactly_that_long(self):
        wait = gate_after_one_failure(failing(429, 600.0, quota_body()), retry_max_s=30.0)
        self.assertTrue(599 < wait <= 600.5, wait)

    def test_the_quota_cap_is_configurable_and_never_below_the_normal_cap(self):
        wait = gate_after_one_failure(failing(429, 43_200.0, quota_body()), retry_max_s=1.0, max_retry_after_s=1, max_quota_retry_after_s=5)
        self.assertTrue(4.5 < wait <= 5.1, wait)
        wait = gate_after_one_failure(failing(429, 43_200.0, quota_body()), retry_max_s=1.0, max_quota_retry_after_s=5)  # normal cap 60: raised to it
        self.assertTrue(59 < wait <= 60.5, wait)
        wait = gate_after_one_failure(failing(429, 43_200.0, quota_body()), retry_max_s=1.0, max_quota_retry_after_s=1, max_retry_after_s=7)
        self.assertTrue(6.5 < wait <= 7.1, wait)  # a quota cap below the normal cap is raised to it

    def test_a_plain_429_and_a_503_still_cap_at_60_seconds(self):
        for status, body in ((429, {"error": "rate_limited", "requestId": "r"}), (503, {"error": "service_unavailable"}), (429, {"error": "quota_exceeded_soon"}),
                             (503, quota_body()), (502, quota_body()), (500, quota_body())):
            wait = gate_after_one_failure(failing(status, 43_200.0, body), retry_max_s=30.0)
            self.assertTrue(59 < wait <= 60.5, (status, body, wait))

    def test_a_missing_or_malformed_body_falls_back_to_the_60_second_cap(self):
        for body in (None, [], "quota_exceeded", 5, {}, {"error": 5}, {"error": None}, {"error": ["quota_exceeded"]}, {"error": "Quota_Exceeded"},
                     {"error": " quota_exceeded"}, {"err": "quota_exceeded"}, {"error": {"code": "quota_exceeded"}}):
            wait = gate_after_one_failure(failing(429, 43_200.0, body), retry_max_s=30.0)
            self.assertTrue(59 < wait <= 60.5, (body, wait))

    def test_the_cap_applies_only_to_retry_after_the_backoff_itself_is_unchanged(self):
        mon = make(FakeTransport(), retry_base_s=1.0, retry_max_s=30.0)
        c = core(mon)
        c.rand = lambda: 0.0
        self.assertEqual(c.backoff_delay(1, 86_400.0, 900.0), 900.0)
        self.assertEqual(c.backoff_delay(1, 86_400.0), 60.0)
        self.assertEqual(c.backoff_delay(1, None, 900.0), 0.5)  # no Retry-After: just the computed backoff
        self.assertEqual(c.backoff_delay(1, 3.0, 900.0), 3.0)
        mon.shutdown(0)

    def test_the_quota_reason_is_visible_in_the_stats_and_does_not_drop_events(self):
        t = ScriptedTransport(lambda events: failing(429, 3600.0, quota_body()))
        mon = make(t)
        for i in range(3):
            mon.track(name=str(i))
        mon.flush(timeout=5)
        s = mon.stats
        self.assertEqual((s["last_error"], s["queue_size"], s["events_failed"]), ("quota_exceeded", 3, 0))
        mon.shutdown(0)

    def test_over_real_http_a_quota_429_parks_the_thread_while_a_plain_429_does_not(self):
        def quota_handler(rec):
            return 429, quota_body(), {"Retry-After": "86400"}
        def plain_handler(rec):
            return 429, {"error": "rate_limited", "requestId": "r"}, {"Retry-After": "86400"}
        results = {}
        for name, handler in (("quota", quota_handler), ("plain", plain_handler)):
            with IngestServer(handler=handler) as server:
                mon = Monitor(API_KEY, server.url, flush_interval_ms=20, min_flush_interval_ms=20, retry_base_s=0.02, retry_max_s=0.05,
                              max_retry_after_s=0.15, max_quota_retry_after_s=60)
                mon.track(name="x")
                self.assertTrue(wait_until(lambda: len(server.requests) >= 1, 3))
                time.sleep(0.8)
                results[name] = len(server.requests)
                if name == "quota":
                    self.assertGreater(core(mon).retry_at - time.monotonic(), 50)  # parked for about a minute
                mon.shutdown(0)
        self.assertEqual(results["quota"], 1)  # one refused request, then silence for the quota wait
        self.assertGreaterEqual(results["plain"], 3)  # a plain 429 keeps retrying at the short cap


class TestTooLargeAndPoison(unittest.TestCase):
    def test_a_413_halves_the_batch_until_the_server_accepts_it_and_loses_nothing(self):
        def respond(events):
            return fail_result(413) if len(events) > 2 else ok_result(events)
        t = ScriptedTransport(respond)
        mon = make(t, batch_size=10)
        for i in range(10):
            mon.track(name="e%02d" % i)
        self.assertTrue(mon.flush(timeout=5))
        delivered = [e["name"] for b in t.batches if len(b) <= 2 for e in b]
        self.assertEqual(delivered, ["e%02d" % i for i in range(10)])  # all, once, in order
        self.assertEqual(max(len(b) for b in t.batches if len(b) <= 2), 2)
        s = mon.stats
        self.assertEqual((s["events_failed"], s["consecutive_failures"], s["queue_size"]), (0, 0, 0))  # no backoff, nothing dropped
        mon.shutdown(0)

    def test_the_batch_size_grows_back_after_successes(self):
        t = ScriptedTransport(lambda events: fail_result(413) if len(events) > 2 else ok_result(events))
        mon = make(t, batch_size=16)
        for i in range(16):
            mon.track(name=str(i))
        mon.flush(timeout=5)
        self.assertLess(core(mon).batch_cap, 16)
        for i in range(40):
            mon.track(name="more%d" % i)
            mon.flush(timeout=5)
        self.assertEqual(core(mon).batch_cap, 16)
        mon.shutdown(0)

    def test_a_single_event_that_is_too_large_is_dropped(self):
        t = ScriptedTransport(lambda events: fail_result(413))
        mon = make(t)
        mon.track(name="huge")
        mon.flush(timeout=5)
        s = mon.stats
        self.assertEqual((s["events_failed"], s["queue_size"]), (1, 0))
        mon.shutdown(0)

    def test_a_poison_event_is_isolated_and_dropped_while_every_other_event_is_delivered_once(self):
        def respond(events):
            return fail_result(500) if any(e.get("name") == "poison" for e in events) else ok_result(events)
        t = ScriptedTransport(respond)
        mon = make(t, batch_size=20)
        for i in range(20):
            mon.track(name="poison" if i == 7 else "e%02d" % i)
        self.assertTrue(drain(mon))
        delivered = [e["name"] for b in t.batches if not any(x["name"] == "poison" for x in b) for e in b]
        self.assertEqual(delivered, ["e%02d" % i for i in range(20) if i != 7])
        s = mon.stats
        self.assertEqual(s["events_failed"], 1)  # only the poison event was given up on
        self.assertEqual(s["queue_size"], 0)
        mon.shutdown(0)

    def test_an_unavailable_server_never_causes_events_to_be_given_up_on(self):
        t = ScriptedTransport(lambda events: fail_result(503))
        mon = make(t)
        mon.track(name="only")
        for _ in range(30):
            mon.flush(timeout=5)
        s = mon.stats
        self.assertEqual((s["events_failed"], s["queue_size"]), (0, 1))
        mon.shutdown(0)


class TestExpiry(unittest.TestCase):
    def test_events_that_waited_longer_than_the_maximum_age_are_not_sent(self):
        fake = FakeTransport()
        mon = make(fake, max_event_age_s=1)
        for i in range(3):
            mon.track(name="old%d" % i)
        time.sleep(1.2)
        mon.track(name="fresh")
        mon.flush(timeout=5)
        self.assertEqual([e["name"] for e in fake.all_events()], ["fresh"])
        self.assertEqual(mon.stats["events_expired"], 3)
        mon.shutdown(0)


class TestOutage(unittest.TestCase):
    def test_a_server_that_is_down_for_a_while_loses_nothing(self):
        state = {"down": True}
        with IngestServer(handler=lambda rec: (503, {"error": "service_unavailable"}, {}) if state["down"] else (202, None, {})) as server:
            mon = Monitor(API_KEY, server.url, flush_interval_ms=100, min_flush_interval_ms=20, retry_base_s=0.05, retry_max_s=0.2, queue_size=1000)
            for i in range(50):
                mon.track(name="e%02d" % i)
            self.assertTrue(wait_until(lambda: mon.stats["batches_failed"] >= 2, 5))
            self.assertEqual(mon.stats["events_failed"], 0)
            self.assertTrue(mon._thread_alive())
            state["down"] = False
            self.assertTrue(wait_until(lambda: mon.stats["events_sent"] == 50, 10))
            ok_events = [e["name"] for r in server.requests if r["body"] and r["path"] and r is not None for e in r["body"]["events"]]
            # every event arrives, in order; the failed attempts delivered the same events again, which the server dedupes by event_id
            self.assertEqual(sorted(set(ok_events)), ["e%02d" % i for i in range(50)])
            mon.shutdown()

    def test_a_refused_connection_is_survived_and_the_events_arrive_when_the_server_appears(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()  # nothing listens on this port yet
        mon = Monitor(API_KEY, "http://127.0.0.1:%d" % port, flush_interval_ms=100, min_flush_interval_ms=20, retry_base_s=0.05, retry_max_s=0.2, timeout_s=1.0)
        for i in range(30):
            mon.track(name="e%02d" % i)
        self.assertTrue(wait_until(lambda: mon.stats["batches_failed"] >= 2, 5))
        self.assertEqual(mon.stats["queue_size"], 30)
        with IngestServer(port=port) as server:
            self.assertTrue(wait_until(lambda: mon.stats["events_sent"] == 30, 10))
            self.assertEqual(server.names(), sorted("e%02d" % i for i in range(30)))
        mon.shutdown(0)

    def test_memory_stays_bounded_during_a_long_outage_and_the_newest_events_survive(self):
        t = ScriptedTransport(lambda events: fail_result(None))
        mon = make(t, queue_size=20, flush_interval_ms=50, retry_base_s=0.02, retry_max_s=0.05)
        for i in range(200):
            mon.track(name="e%03d" % i)
            if i % 40 == 0:
                time.sleep(0.05)
        s = mon.stats
        self.assertLessEqual(s["queue_size"], 20)
        self.assertGreaterEqual(s["events_dropped_queue_full"], 180 - 20)
        t.respond = ok_result
        self.assertTrue(wait_until(lambda: mon.stats["queue_size"] == 0, 5))
        names = [e["name"] for b in t.batches[-3:] for e in b]
        self.assertIn("e199", names)  # the newest survived
        mon.shutdown(0)

    def test_the_thread_does_not_hammer_a_struggling_server(self):
        with IngestServer(status=503, body={"error": "x"}) as server:
            mon = Monitor(API_KEY, server.url, flush_interval_ms=20, min_flush_interval_ms=20, retry_base_s=0.2, retry_max_s=0.4)
            for i in range(10):
                mon.track(name="e%d" % i)
            time.sleep(1.5)
            self.assertLessEqual(len(server.requests), 7)  # backoff 0.1..0.2, 0.2..0.4, ... not a tight loop
            self.assertGreaterEqual(len(server.requests), 2)
            mon.shutdown(0)

    def test_the_flush_thread_sleeps_through_the_backoff_instead_of_spinning(self):
        from llm_monitor import monitor as monitor_module
        calls = {"n": 0}
        original = monitor_module._Core.send_all

        def counting(self, deadline, respect_gate):
            if respect_gate:
                calls["n"] += 1
            return original(self, deadline, respect_gate)

        t = ScriptedTransport(lambda events: fail_result(503))
        mon = make(t, batch_size=1, flush_interval_ms=20, retry_base_s=10.0, retry_max_s=20.0)  # the gate closes for ~5-10 s
        monitor_module._Core.send_all = counting
        try:
            mon.track(name="x")
            self.assertTrue(wait_until(lambda: mon.stats["batches_failed"] >= 1, 3))
            time.sleep(0.2)
            calls["n"] = 0
            time.sleep(0.8)
            self.assertLessEqual(calls["n"], 3, "the flush thread is spinning while the backoff gate is closed")
        finally:
            monitor_module._Core.send_all = original
            mon.shutdown(0)

    def test_shutdown_during_an_outage_returns_within_its_budget_and_never_raises(self):
        t = ScriptedTransport(lambda events: fail_result(None))
        mon = make(t, flush_interval_ms=50)
        for i in range(10):
            mon.track(name=str(i))
        started = time.monotonic()
        mon.shutdown(timeout=0.5)
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertFalse(mon._thread_alive())

    def test_an_explicit_flush_during_an_outage_makes_one_attempt_and_reports_failure(self):
        t = ScriptedTransport(lambda events: fail_result(503))
        mon = make(t, retry_base_s=30.0, retry_max_s=60.0)  # the gate is far in the future
        mon.track(name="x")
        mon.flush(timeout=5)
        before = len(t.batches)
        self.assertFalse(mon.flush(timeout=5))  # the user asked: it tries now, whatever the gate says
        self.assertEqual(len(t.batches), before + 1)
        mon.shutdown(0)


class TestFlushHint(unittest.TestCase):
    def test_the_hint_sets_the_interval_clamped_to_the_configured_range(self):
        for hint, expected in ((150, 150), (5, 20), (10**9, 60_000), (1000.5, 1000.5)):
            t = ScriptedTransport(lambda events, h=hint: ok_result(events, h))
            mon = make(t)
            mon.track(name="x")
            mon.flush(timeout=5)
            self.assertEqual(mon.stats["interval_ms"], expected, hint)
            mon.shutdown(0)

    def test_nonsense_hints_are_ignored(self):
        for hint in ("fast", True, None, float("nan"), -5, 0, [1000]):
            t = ScriptedTransport(lambda events, h=hint: ok_result(events, h))
            mon = make(t, flush_interval_ms=777)
            mon.track(name="x")
            mon.flush(timeout=5)
            self.assertEqual(mon.stats["interval_ms"], 777, repr(hint))
            mon.shutdown(0)

    def test_the_next_flush_follows_the_hint_not_the_configured_interval(self):
        hints = {"value": 150}
        t = ScriptedTransport(lambda events: ok_result(events, hints["value"]))
        mon = make(t, batch_size=2, flush_interval_ms=60_000)
        mon.track(name="a")
        mon.track(name="b")  # a full batch: sent at once, the answer says "flush every 150 ms"
        self.assertTrue(wait_until(lambda: mon.stats["interval_ms"] == 150))
        mon.track(name="lonely")  # not a full batch: only the interval can send it, and the interval is now 150 ms
        started = time.monotonic()
        self.assertTrue(wait_until(lambda: len(t.delivered()) == 3, 3))
        self.assertLess(time.monotonic() - started, 2.0)  # not 60 s
        # and the server can slow the SDK down again
        hints["value"] = 60_000
        mon.track(name="x")
        mon.track(name="y")
        self.assertTrue(wait_until(lambda: mon.stats["interval_ms"] == 60_000 or len(t.delivered()) >= 5, 3))
        mon.shutdown(0)

    def test_a_hint_learned_by_an_explicit_flush_wakes_a_thread_that_is_waiting_on_a_long_interval(self):
        t = ScriptedTransport(lambda events: ok_result(events, 100))
        mon = make(t, flush_interval_ms=60_000)
        mon.track(name="first")  # starts the thread, which now waits ~60 s
        time.sleep(0.3)  # make sure the thread is really blocked in its wait (otherwise it would read the new interval by luck)
        self.assertTrue(mon.flush(timeout=5))  # the answer says 100 ms
        mon.track(name="second")
        self.assertTrue(wait_until(lambda: len(t.delivered()) == 2, 3))
        mon.shutdown(0)

    def test_failures_do_not_change_the_interval(self):
        t = ScriptedTransport(lambda events: fail_result(503))
        mon = make(t, flush_interval_ms=777)
        mon.track(name="x")
        mon.flush(timeout=5)
        self.assertEqual(mon.stats["interval_ms"], 777)
        mon.shutdown(0)


class TestByteSplittingAndGzip(unittest.TestCase):
    def test_batches_are_split_by_bytes_as_well_as_by_count(self):
        with IngestServer() as server:
            mon = Monitor(API_KEY, server.url, capture_content=True, queue_size=1000, flush_interval_ms=60_000, min_flush_interval_ms=20)
            for i in range(100):  # ~4.3 KB each: about 430 KB, far over the server's 256,000-byte body limit
                mon.track(name="e%03d" % i, model="m", content={"input": "x" * 2048, "output": "y" * 2048})
            self.assertTrue(mon.flush(timeout=10))
            sizes = [len(r["raw"]) for r in server.requests]
            self.assertGreaterEqual(len(sizes), 3)
            self.assertTrue(all(n <= 200_000 + 16 for n in sizes), sizes)  # the cap, plus the {"events":[ ]} wrapper
            self.assertTrue(all(len(r["body"]["events"]) <= 100 for r in server.requests))
            names = [e["name"] for r in server.requests for e in r["body"]["events"]]
            self.assertEqual(names, ["e%03d" % i for i in range(100)])  # all, once, in order
            mon.shutdown()

    def test_a_smaller_configured_byte_cap_makes_smaller_batches(self):
        fake = FakeTransport()
        mon = make(fake, max_batch_bytes=2_000)  # clamped up to the 1,000-byte minimum rules, still tiny
        for i in range(60):
            mon.track(name="n" * 100, model="m")
        mon.flush(timeout=5)
        self.assertGreater(len(fake.batches), 3)
        self.assertEqual(len(fake.all_events()), 60)
        mon.shutdown(0)

    def test_small_events_still_go_in_one_batch_of_100(self):
        fake = FakeTransport()
        mon = make(fake)
        for i in range(100):
            mon.track(name="e")
        mon.flush(timeout=5)
        self.assertEqual([len(b) for b in fake.batches], [100])
        mon.shutdown(0)

    def test_large_bodies_are_gzipped_and_arrive_intact_small_ones_are_not(self):
        with IngestServer() as server:
            mon = Monitor(API_KEY, server.url, flush_interval_ms=60_000, min_flush_interval_ms=20)
            mon.track(name="tiny")
            mon.flush(timeout=5)
            for i in range(50):
                mon.track(name="e%02d" % i, model="gpt-4o", provider="openai", input_tokens=100 + i, output_tokens=20)
            mon.flush(timeout=5)
            tiny, big = server.requests
            self.assertNotIn("content-encoding", tiny["headers"])
            self.assertEqual(big["headers"]["content-encoding"], "gzip")
            self.assertLess(big["wire_bytes"], len(big["raw"]))  # smaller on the wire
            self.assertEqual(len(big["body"]["events"]), 50)  # and the server read it back
            mon.shutdown()

    def test_gzip_can_be_switched_off(self):
        with IngestServer() as server:
            mon = Monitor(API_KEY, server.url, compress=False, flush_interval_ms=60_000, min_flush_interval_ms=20)
            for i in range(50):
                mon.track(name="e%02d" % i, model="gpt-4o")
            mon.flush(timeout=5)
            self.assertNotIn("content-encoding", server.requests[0]["headers"])
            self.assertEqual(server.requests[0]["wire_bytes"], len(server.requests[0]["raw"]))
            mon.shutdown()


class TestEndToEndPoisonWithARealServer(unittest.TestCase):
    def test_poison_isolation_over_http(self):
        def handler(rec):
            events = (rec["body"] or {}).get("events", [])
            if any(e.get("name") == "poison" for e in events):
                return 500, {"error": "internal"}, {}
            return 202, None, {}
        with IngestServer(handler=handler) as server:
            mon = Monitor(API_KEY, server.url, batch_size=16, flush_interval_ms=60_000, min_flush_interval_ms=20, retry_base_s=0.01, retry_max_s=0.05)
            for i in range(16):
                mon.track(name="poison" if i == 3 else "e%02d" % i)
            for _ in range(100):
                if mon.flush(timeout=5) and mon._queue_len() == 0:
                    break
            ok = [e["name"] for r in server.requests if r["body"] and not any(x["name"] == "poison" for x in r["body"]["events"]) for e in r["body"]["events"]]
            self.assertEqual(ok, ["e%02d" % i for i in range(16) if i != 3])
            self.assertEqual(mon.stats["events_failed"], 1)
            mon.shutdown()


if __name__ == "__main__":
    unittest.main()
