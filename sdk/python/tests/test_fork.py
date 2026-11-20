"""Fork safety, for BOTH start methods that matter: 'fork' (a copy of the parent's memory, incl. a Monitor whose flush
thread does not exist in the child) and 'forkserver' (the default on Linux since Python 3.14; the Monitor is pickled).

In both cases the child must (1) NOT share the parent's queue, (2) have a flush thread of its own, and (3) not re-send
anything the parent still holds."""
import multiprocessing
import os
import unittest
import warnings

from llm_monitor import Monitor
from _helpers import API_KEY, IngestServer, child_background_delivery, child_flush_own_event, wait_until

METHODS = [m for m in ("fork", "forkserver") if m in multiprocessing.get_all_start_methods()]


def monitor_for(server, **options):
    options.setdefault("min_flush_interval_ms", 20)
    options.setdefault("flush_interval_ms", 60_000)
    return Monitor(API_KEY, server.url, **options)


class TestStartMethods(unittest.TestCase):
    def run_child(self, method, target, args):
        ctx = multiprocessing.get_context(method)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)  # Python 3.12+: os.fork() in a multi-threaded process
            proc = ctx.Process(target=target, args=args)
            proc.start()
        proc.join(60)
        if proc.is_alive():
            proc.kill()
            self.fail("child did not finish")
        return proc.exitcode

    def test_the_methods_under_test_exist(self):
        self.assertTrue(METHODS, "no fork-like start method on this platform")

    def test_child_does_not_share_the_parents_queue_and_has_its_own_thread(self):
        for method in METHODS:
            with self.subTest(method=method), IngestServer() as server:
                mon = monitor_for(server)
                mon.track(name="parent-event")  # stays queued: the interval is 60 s; the parent's thread is now running
                self.assertTrue(mon._thread_alive())
                parent_thread = mon._thread_ident()
                code = self.run_child(method, child_flush_own_event, (mon, "child-event", parent_thread))
                self.assertEqual(code, 0, "child exit code %s (3 = shared the parent's queue, 4 = no own flush thread, 5 = flush failed)" % code)
                self.assertEqual(server.names(), ["child-event"])  # the parent's event was NOT sent by the child
                self.assertEqual(mon._queue_len(), 1)  # ...and is still in the parent's queue
                self.assertTrue(mon.flush(5))
                self.assertEqual(server.names(), ["child-event", "parent-event"])  # each exactly once
                self.assertEqual(len(server.events()), 2)
                mon.shutdown()

    def test_the_childs_restarted_background_thread_delivers_without_any_flush_call(self):
        for method in METHODS:
            with self.subTest(method=method), IngestServer() as server:
                mon = monitor_for(server, batch_size=1)  # every event triggers the flush thread at once
                mon.track(name="parent-first")
                self.assertTrue(wait_until(lambda: len(server.events()) == 1))  # the parent's own thread works and is now idle
                code = self.run_child(method, child_background_delivery, (mon, "child-second", 15.0))
                self.assertEqual(code, 0, "child exit code %s (6 = its background thread did not deliver)" % code)
                self.assertEqual(server.names(), ["child-first"[:0] + "child-second", "parent-first"])
                self.assertEqual(len(server.events()), 2)  # nothing duplicated
                mon.shutdown()

    @unittest.skipUnless(hasattr(os, "fork"), "needs os.fork")
    def test_raw_os_fork_with_the_same_monitor_object(self):
        with IngestServer() as server:
            mon = monitor_for(server)
            mon.track(name="parent-event")
            parent_thread = mon._thread_ident()
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                pid = os.fork()
            if pid == 0:  # child
                try:
                    started_empty = mon._queue_len() == 0
                    mon.track(name="child-event")
                    own_thread = mon._thread_alive() and mon._thread_ident() != parent_thread
                    ok = started_empty and own_thread and mon.flush(5)
                    os._exit(0 if ok else 1)
                except BaseException:
                    os._exit(2)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.WEXITSTATUS(status), 0)
            self.assertEqual(server.names(), ["child-event"])
            mon.flush(5)
            self.assertEqual(server.names(), ["child-event", "parent-event"])
            mon.shutdown()


if __name__ == "__main__":
    unittest.main()
