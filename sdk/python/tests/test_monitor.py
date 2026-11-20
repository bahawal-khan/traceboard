import gc
import os
import pickle
import threading
import time
import unittest
import warnings
from unittest import mock

import llm_monitor
from llm_monitor import Monitor, monitor as monitor_module
from _helpers import API_KEY, FakeTransport, wait_until

URL = "https://monitor.example.com"


def make(transport=None, **options):
    options.setdefault("min_flush_interval_ms", 20)
    options.setdefault("flush_interval_ms", 60_000)
    return Monitor(API_KEY, URL, transport=transport if transport is not None else FakeTransport(), **options)


class TestDisabled(unittest.TestCase):
    def setUp(self):
        for name in ("LLM_MONITOR_API_KEY", "LLM_MONITOR_URL"):
            patcher = mock.patch.dict(os.environ)
            patcher.start()
            self.addCleanup(patcher.stop)
            os.environ.pop(name, None)

    def test_a_missing_configuration_disables_the_sdk_without_raising(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            monitor_module._announced = False
            mon = Monitor()
        self.assertFalse(mon.enabled)
        self.assertIn("API key", mon.config_error)
        self.assertEqual([w.category for w in caught], [RuntimeWarning])  # said once, loudly enough
        self.assertIsNone(mon.track(name="x"))
        self.assertTrue(mon.flush())
        mon.shutdown()
        self.assertEqual(mon.stats["events_dropped_disabled"], 1)
        self.assertFalse(mon.stats["enabled"])
        self.assertEqual(threading.active_count(), threading.active_count())  # no thread was needed
        self.assertFalse(mon._thread_alive())

    def test_even_with_warnings_set_to_errors_construction_never_raises(self):
        monitor_module._announced = False
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            mon = Monitor()
        self.assertFalse(mon.enabled)

    def test_bad_option_values_do_not_raise(self):
        mon = Monitor(API_KEY, URL, batch_size=object(), queue_size="x", flush_interval_ms=None, timeout_s=[])
        self.assertTrue(mon.enabled)
        mon.shutdown(0)

    def test_repr_and_str_never_contain_the_key(self):
        mon = make()
        for text in (repr(mon), str(mon), repr(mon.stats)):
            self.assertNotIn(API_KEY, text)
            self.assertNotIn("AAAAAAAAAA", text)
        mon.shutdown(0)


class TestBatching(unittest.TestCase):
    def test_a_full_batch_is_sent_immediately_by_the_background_thread(self):
        fake = FakeTransport()
        mon = make(fake, batch_size=5)
        for i in range(5):
            mon.track(name="e%d" % i)
        self.assertTrue(wait_until(lambda: len(fake.batches) == 1))
        self.assertEqual(len(fake.batches[0]), 5)
        mon.shutdown()

    def test_a_partial_batch_is_sent_when_the_interval_passes(self):
        fake = FakeTransport()
        mon = make(fake, flush_interval_ms=100)
        mon.track(name="lonely")
        self.assertTrue(wait_until(lambda: len(fake.all_events()) == 1, 3))
        mon.shutdown()

    def test_nothing_is_sent_before_the_interval_or_a_full_batch(self):
        fake = FakeTransport()
        mon = make(fake)
        for i in range(10):
            mon.track(name="e%d" % i)
        time.sleep(0.3)
        self.assertEqual(fake.batches, [])
        self.assertEqual(mon.stats["queue_size"], 10)
        mon.shutdown()

    def test_flush_sends_everything_in_batches_of_at_most_batch_size(self):
        fake = FakeTransport()
        mon = make(fake, batch_size=3)
        mon._holder.core.cfg  # config is built
        # Hold the background thread off so the batch layout is deterministic: no thread-triggered sends below batch_size.
        for i in range(7):
            mon.track(name="e%d" % i)
        self.assertTrue(mon.flush())
        sizes = sorted(len(b) for b in fake.batches)
        self.assertEqual(sum(sizes), 7)
        self.assertTrue(all(s <= 3 for s in sizes))
        mon.shutdown()

    def test_the_server_limit_of_100_events_per_batch_is_never_exceeded(self):
        fake = FakeTransport()
        mon = make(fake, batch_size=100_000)  # clamped to 100
        for i in range(450):
            mon.track(name="e%d" % i)
        self.assertTrue(mon.flush())
        self.assertEqual(len(fake.all_events()), 450)
        self.assertLessEqual(max(len(b) for b in fake.batches), 100)
        mon.shutdown()

    def test_events_keep_their_order(self):
        fake = FakeTransport()
        mon = make(fake, batch_size=10)
        for i in range(35):
            mon.track(name="e%03d" % i)
        mon.flush()
        names = [e["name"] for e in fake.all_events()]
        self.assertEqual(names, sorted(names))
        mon.shutdown()


class TestFlushAndShutdown(unittest.TestCase):
    def test_shutdown_does_a_final_flush_and_later_events_are_ignored(self):
        fake = FakeTransport()
        mon = make(fake)
        for i in range(3):
            mon.track(name="e%d" % i)
        mon.shutdown()
        self.assertEqual(len(fake.all_events()), 3)
        self.assertFalse(mon._thread_alive())
        self.assertIsNone(mon.track(name="late"))
        self.assertEqual(mon.stats["events_dropped_closed"], 1)
        mon.shutdown()  # idempotent
        self.assertEqual(len(fake.all_events()), 3)

    def test_context_manager_flushes_on_exit(self):
        fake = FakeTransport()
        with make(fake) as mon:
            mon.track(name="a")
        self.assertEqual(len(fake.all_events()), 1)

    def test_a_garbage_collected_monitor_flushes_and_stops_its_thread(self):
        fake = FakeTransport()
        mon = make(fake)
        mon.track(name="a")
        thread = mon._holder.core.thread
        self.assertTrue(thread.is_alive())
        del mon
        gc.collect()
        self.assertTrue(wait_until(lambda: len(fake.all_events()) == 1, 3))
        self.assertTrue(wait_until(lambda: not thread.is_alive(), 3))

    def test_flush_gives_up_after_its_timeout_when_the_sender_is_busy_and_never_raises(self):
        fake = FakeTransport()
        fake.release.clear()  # the next send blocks
        mon = make(fake, batch_size=1)
        mon.track(name="blocks-the-thread")
        self.assertTrue(wait_until(lambda: mon._holder.core.send_lock.locked()))
        mon.track(name="waits")
        started = time.monotonic()
        self.assertFalse(mon.flush(timeout=0.3))
        self.assertLess(time.monotonic() - started, 2.0)
        fake.release.set()
        self.assertTrue(wait_until(lambda: len(fake.all_events()) == 2))
        self.assertTrue(mon.flush())
        mon.shutdown()


class TestBackpressure(unittest.TestCase):
    def test_a_full_queue_drops_the_oldest_events_and_counts_them(self):
        fake = FakeTransport()
        mon = make(fake, queue_size=10, batch_size=100)
        for i in range(25):
            mon.track(name="e%02d" % i)
        s = mon.stats
        self.assertEqual((s["queue_size"], s["events_dropped_queue_full"], s["events_tracked"]), (10, 15, 25))
        mon.flush()
        self.assertEqual([e["name"] for e in fake.all_events()], ["e%02d" % i for i in range(15, 25)])
        mon.shutdown()

    def test_many_threads_tracking_at_once_lose_and_duplicate_nothing(self):
        fake = FakeTransport()
        mon = make(fake, queue_size=100_000, flush_interval_ms=50)
        def worker(n):
            for i in range(500):
                mon.track(name="t%d-%d" % (n, i))
        threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertTrue(mon.flush(timeout=10))
        events = fake.all_events()
        self.assertEqual(len(events), 4000)
        self.assertEqual(len({e["event_id"] for e in events}), 4000)
        self.assertEqual(mon.stats["events_sent"], 4000)
        mon.shutdown()


class TestFailuresNeverReachTheHostApp(unittest.TestCase):
    def test_a_permanent_failure_drops_the_batch_and_the_next_batch_still_goes(self):
        fake = FakeTransport(ok=False, status=400)
        mon = make(fake, batch_size=2)
        mon.track(name="a")
        mon.track(name="b")
        self.assertTrue(wait_until(lambda: mon.stats["batches_failed"] == 1))
        s = mon.stats
        self.assertEqual((s["events_failed"], s["last_error"], s["batches_sent"], s["queue_size"]), (2, "http_400", 0, 0))
        fake.ok = True
        mon.track(name="c")
        mon.track(name="d")
        self.assertTrue(wait_until(lambda: mon.stats["batches_sent"] == 1))
        self.assertEqual(mon.stats["events_sent"], 2)
        mon.shutdown()

    def test_a_transient_failure_keeps_the_events_and_delivers_them_after_a_backoff(self):
        fake = FakeTransport(ok=False, status=503)
        mon = make(fake, batch_size=2, retry_base_s=0.05, retry_max_s=0.1)
        mon.track(name="a")
        mon.track(name="b")
        self.assertTrue(wait_until(lambda: mon.stats["batches_requeued"] >= 1))
        self.assertEqual(mon.stats["events_failed"], 0)  # nothing was thrown away
        fake.ok = True
        self.assertTrue(wait_until(lambda: mon.stats["events_sent"] == 2, 5))
        self.assertEqual([e["name"] for e in fake.all_events()][-2:], ["a", "b"])
        self.assertEqual(mon.stats["consecutive_failures"], 0)
        mon.shutdown()

    def test_a_raising_transport_is_swallowed_and_the_thread_survives(self):
        fake = FakeTransport(raises=RuntimeError("boom with secret " + API_KEY))
        mon = make(fake, batch_size=1, retry_base_s=0.02, retry_max_s=0.05)
        mon.track(name="a")
        self.assertTrue(wait_until(lambda: mon.stats["batches_failed"] >= 1))
        self.assertNotIn(API_KEY, repr(mon.stats))  # the error is recorded by class, never by message
        self.assertTrue(mon._thread_alive())
        fake.raises = None
        self.assertTrue(wait_until(lambda: mon.stats["batches_sent"] == 1, 5))  # the event was kept and is delivered
        mon.shutdown()

    def test_track_never_raises_whatever_it_is_given(self):
        mon = make()
        junk = [None, object(), float("nan"), "\ud800", b"x", [1, [2]], {"a": {"b": 1}}, 10**400, lambda: 1]
        for v in junk:
            mon.track(name=v, model=v, tags=v, content=v, ts=v, event_id=v, input_tokens=v)
        mon.track()
        self.assertEqual(mon.stats["events_tracked"], len(junk) + 1)
        mon.shutdown(0)

    def test_an_internal_error_in_track_is_counted_not_raised(self):
        mon = make()
        with mock.patch("llm_monitor.monitor.build_event", side_effect=RuntimeError("internal")):
            self.assertIsNone(mon.track(name="x"))
        self.assertEqual(mon.stats["errors"], 1)
        self.assertIsNotNone(mon.track(name="y"))  # and it keeps working
        mon.shutdown(0)

    def test_flush_and_shutdown_never_raise_even_if_the_internals_do(self):
        mon = make()
        mon.track(name="x")
        with mock.patch.object(monitor_module._Core, "send_all", side_effect=RuntimeError("internal")):
            self.assertFalse(mon.flush())
            mon.shutdown()


class TestStatsAndContent(unittest.TestCase):
    def test_server_answers_feed_the_counters(self):
        class T(FakeTransport):
            def send(self, events):
                from llm_monitor._transport import SendResult
                return SendResult(True, 202, {"accepted": 5, "duplicates": 2, "rejected": [{"event_id": "x", "reason": "ts_too_old"}], "flush_hint_ms": 12000}, None, None)
        mon = make(T())
        for i in range(6):
            mon.track(name=str(i))
        mon.flush()
        s = mon.stats
        self.assertEqual((s["events_sent"], s["events_duplicate"], s["events_rejected"], s["batches_sent"], s["last_flush_hint_ms"]), (3, 2, 1, 1, 12000))
        mon.shutdown()

    def test_dropped_fields_are_counted(self):
        mon = make()
        mon.track(name="x", cost_usd=1, bogus=2, input_tokens=-5)
        self.assertEqual(mon.stats["fields_dropped"], 3)
        mon.shutdown(0)

    def test_content_is_sent_only_when_capture_is_on(self):
        for capture in (False, True):
            fake = FakeTransport()
            mon = make(fake, capture_content=capture)
            mon.track(name="x", content={"input": "hello"})
            mon.flush()
            self.assertEqual("content" in fake.all_events()[0], capture)
            mon.shutdown()


class TestForkHookAndPickle(unittest.TestCase):
    def test_the_after_fork_hook_gives_the_monitor_a_fresh_core(self):
        fake = FakeTransport()
        mon = make(fake)
        mon.track(name="parent")
        old = mon._holder.core
        monitor_module._after_fork_in_child()  # what the interpreter calls in a forked child
        new = mon._holder.core
        self.assertIsNot(new, old)
        self.assertIsNot(new.queue, old.queue)
        self.assertIsNot(new.lock, old.lock)
        self.assertEqual(len(new.queue), 0)
        self.assertIsNone(new.thread)
        self.assertEqual(new.stats["events_tracked"], 0)
        old.shutdown(0)  # clean up the "parent" side of this simulation

    def test_a_pid_mismatch_alone_also_yields_a_fresh_core(self):
        mon = make()
        mon.track(name="x")
        mon._holder.core.pid = os.getpid() + 1  # pretend the object came from another process
        self.assertEqual(mon._queue_len(), 0)
        mon.shutdown(0)

    def test_pickling_rebuilds_a_fresh_monitor_with_the_same_settings(self):
        mon = make(batch_size=7, queue_size=123, capture_content=True)
        mon.track(name="pending")
        clone = pickle.loads(pickle.dumps(mon))
        self.assertIsNot(clone, mon)
        self.assertTrue(clone.enabled)
        cfg = clone._holder.core.cfg
        self.assertEqual((cfg.batch_size, cfg.queue_size, cfg.capture_content, cfg.base_url), (7, 123, True, URL))
        self.assertEqual(clone._queue_len(), 0)  # the queue is never shared or copied
        self.assertFalse(clone._thread_alive())
        mon.shutdown(0)
        clone.shutdown(0)


if __name__ == "__main__":
    unittest.main()
