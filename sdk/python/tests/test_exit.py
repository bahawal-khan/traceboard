"""Flush at exit and fork behaviour in a real interpreter (subprocesses), so atexit and finalizers actually run."""
import os
import subprocess
import sys
import textwrap
import unittest

from _helpers import API_KEY, IngestServer, wait_until

SDK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_python(code, server, timeout=30):
    env = dict(os.environ, LLM_MONITOR_API_KEY=API_KEY, LLM_MONITOR_URL=server.url, PYTHONPATH=SDK_ROOT)
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], env=env, capture_output=True, text=True, timeout=timeout)


class TestFlushAtExit(unittest.TestCase):
    def test_events_still_queued_when_the_program_ends_are_delivered(self):
        with IngestServer() as server:
            p = run_python("""
                from llm_monitor import Monitor
                mon = Monitor()
                for i in range(3):
                    mon.track(name="exit-%d" % i)
                # no flush, no shutdown: the program just ends
            """, server)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(server.names(), ["exit-0", "exit-1", "exit-2"])
            self.assertEqual(p.stderr, "")  # nothing noisy on stderr

    def test_an_uncaught_exception_and_sys_exit_still_flush(self):
        for body in ("raise RuntimeError('app crashed')", "import sys; sys.exit(3)"):
            with IngestServer() as server:
                p = run_python("""
                    from llm_monitor import Monitor
                    mon = Monitor()
                    mon.track(name="before-end")
                    %s
                """ % body, server)
                self.assertNotEqual(p.returncode, 0)
                self.assertEqual(server.names(), ["before-end"], body)

    def test_an_unreachable_server_delays_exit_by_at_most_the_exit_budget_and_prints_nothing(self):
        import time
        env = dict(os.environ, LLM_MONITOR_API_KEY=API_KEY, LLM_MONITOR_URL="http://127.0.0.1:9", PYTHONPATH=SDK_ROOT)
        started = time.monotonic()
        p = subprocess.run([sys.executable, "-c", "from llm_monitor import Monitor\nm = Monitor(exit_flush_timeout_s=1)\nm.track(name='x')"], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(p.stderr, "")

    def test_a_disabled_sdk_is_silent_enough_and_harmless_at_exit(self):
        env = dict(os.environ, PYTHONPATH=SDK_ROOT)
        env.pop("LLM_MONITOR_API_KEY", None)
        env.pop("LLM_MONITOR_URL", None)
        p = subprocess.run([sys.executable, "-c", "from llm_monitor import Monitor\nm = Monitor()\nm.track(name='x')"], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 0)
        self.assertIn("llm_monitor is disabled", p.stderr)  # one RuntimeWarning explains why nothing is sent
        self.assertNotIn("Traceback", p.stderr)


@unittest.skipUnless(hasattr(os, "fork"), "needs os.fork")
class TestForkedChildNeverResendsTheParentsEvents(unittest.TestCase):
    def test_a_child_that_exits_normally_does_not_flush_the_parents_queue(self):
        with IngestServer() as server:
            p = run_python("""
                import os, sys, warnings
                warnings.simplefilter("ignore", DeprecationWarning)   # 3.12+: fork() in a threaded process
                from llm_monitor import Monitor
                mon = Monitor(flush_interval_ms=60000)
                mon.track(name="parent-only")        # queued, not yet sent; the parent's flush thread exists now
                pid = os.fork()
                if pid == 0:
                    # child: exits through the normal interpreter shutdown (atexit + finalizers run here)
                    sys.exit(0)
                _, status = os.waitpid(pid, 0)
                assert status == 0, status
                assert mon.flush(5)
            """, server)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(server.names(), ["parent-only"])  # once, by the parent; the child sent nothing
            self.assertEqual(len(server.events()), 1)

    def test_a_child_tracks_and_exits_normally_and_only_its_own_event_is_flushed_by_it(self):
        with IngestServer() as server:
            p = run_python("""
                import os, sys, warnings
                warnings.simplefilter("ignore", DeprecationWarning)
                from llm_monitor import Monitor
                mon = Monitor(flush_interval_ms=60000)
                mon.track(name="parent-event")
                pid = os.fork()
                if pid == 0:
                    mon.track(name="child-event")
                    sys.exit(0)                      # the child's final flush must send ONLY child-event
                _, status = os.waitpid(pid, 0)
                assert status == 0, status
                mon.shutdown()
            """, server)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(server.names(), ["child-event", "parent-event"])
            self.assertEqual(len(server.events()), 2)


if __name__ == "__main__":
    unittest.main()
