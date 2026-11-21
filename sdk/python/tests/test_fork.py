"""Fork safety, for BOTH start methods that matter: 'fork' (a copy of the parent's memory, incl. a Monitor whose flush
thread does not exist in the child) and 'forkserver' (the default on Linux since Python 3.14; the Monitor is pickled).

In both cases the child must (1) NOT share the parent's queue, (2) have a flush thread of its own, and (3) not re-send
anything the parent still holds."""
import multiprocessing
import os
import threading
import unittest
import warnings

from llm_monitor import Monitor
from _helpers import API_KEY, IngestServer, child_background_delivery, child_flush_own_event, fork_facts, own_flush_thread, wait_until

METHODS = [m for m in ("fork", "forkserver") if m in multiprocessing.get_all_start_methods()]


def monitor_for(server, **options):
    options.setdefault("min_flush_interval_ms", 20)
    options.setdefault("flush_interval_ms", 60_000)
    return Monitor(API_KEY, server.url, **options)


class TestStartMethods(unittest.TestCase):
    def run_child(self, method, target, args, with_report=False):
        """Runs `target(*args[, report])` in a child. Returns the exit code, or (exit code, facts) with `with_report`: the child
        sends a dict describing what it saw, so a failing assertion can say which condition broke and why."""
        ctx = multiprocessing.get_context(method)
        reader = writer = None
        if with_report:
            reader, writer = ctx.Pipe(duplex=False)
            args = tuple(args) + (writer,)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)  # Python 3.12+: os.fork() in a multi-threaded process
            proc = ctx.Process(target=target, args=args)
            proc.start()
        if writer is not None:
            writer.close()  # the parent's copy: the reader sees EOF when the child is gone
        proc.join(60)
        if proc.is_alive():
            proc.kill()
            self.fail("child did not finish")
        if not with_report:
            return proc.exitcode
        facts = reader.recv() if reader.poll(1) else None
        reader.close()
        return proc.exitcode, facts

    def test_the_methods_under_test_exist(self):
        self.assertTrue(METHODS, "no fork-like start method on this platform")

    def test_child_does_not_share_the_parents_queue_and_has_its_own_thread(self):
        for method in METHODS:
            with self.subTest(method=method), IngestServer() as server:
                mon = monitor_for(server)
                mon.track(name="parent-event")  # stays queued: the interval is 60 s; the parent's thread is now running
                self.assertTrue(mon._thread_alive())
                parent_token = mon._thread_token()
                parent_ident = mon._holder.get().thread.ident
                code, facts = self.run_child(method, child_flush_own_event, (mon, "child-event", parent_token), with_report=True)
                # `facts` says which condition failed: started_empty (queue not shared), thread_alive / token_started_in_this_process /
                # token_differs_from_parents (own flush thread), flush_ok. The ident is only reported, never compared.
                self.assertEqual(code, 0, "child exit code %s (3 = shared the parent's queue, 4 = no own flush thread, 5 = flush failed); "
                                 "method=%s parent_pid=%s parent_ident=%s facts=%s" % (code, method, os.getpid(), parent_ident, facts))
                self.assertEqual(server.names(), ["child-event"])  # the parent's event was NOT sent by the child
                self.assertEqual(mon._queue_len(), 1)  # ...and is still in the parent's queue
                self.assertTrue(mon.flush(5))
                self.assertEqual(server.names(), ["child-event", "parent-event"])  # each exactly once
                self.assertEqual(len(server.events()), 2)
                if facts and facts.get("thread_ident") == parent_ident:  # informational: shown in the pytest warnings summary
                    warnings.warn("%s: the child's new flush thread got the SAME Thread.ident as the parent's (%s); expected and harmless, "
                                  "the SDK and these tests do not rely on idents" % (method, parent_ident), UserWarning)
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
            parent_token = mon._thread_token()
            parent_ident = mon._holder.get().thread.ident
            r, w = os.pipe()
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                pid = os.fork()
            if pid == 0:  # child
                try:
                    os.close(r)
                    started_empty = mon._queue_len() == 0
                    mon.track(name="child-event")
                    facts = fork_facts(mon, parent_token, started_empty)
                    flush_ok = mon.flush(5)
                    facts.update(flush_ok=flush_ok, ident_equals_parents=facts["thread_ident"] == parent_ident)
                    os.write(w, repr(facts).encode("utf-8"))
                    os._exit(0 if started_empty and own_flush_thread(facts) and flush_ok else 1)
                except BaseException as err:
                    try:
                        os.write(w, repr({"exception": repr(err)}).encode("utf-8"))
                    except BaseException:
                        pass
                    os._exit(2)
            os.close(w)
            _, status = os.waitpid(pid, 0)
            report = b""
            while True:
                chunk = os.read(r, 65536)
                if not chunk:
                    break
                report += chunk
            os.close(r)
            self.assertEqual(os.WEXITSTATUS(status), 0, "child exit status %s (1 = queue shared, no own flush thread, or flush failed; 2 = exception); "
                             "parent_pid=%s parent_ident=%s child facts=%s" % (os.WEXITSTATUS(status), os.getpid(), parent_ident, report.decode("utf-8", "replace")))
            self.assertEqual(server.names(), ["child-event"])
            mon.flush(5)
            self.assertEqual(server.names(), ["child-event", "parent-event"])
            if ("'ident_equals_parents': True" in report.decode("utf-8", "replace")):
                warnings.warn("raw fork: the child's new flush thread got the SAME Thread.ident as the parent's (%s); expected and harmless" % parent_ident, UserWarning)
            mon.shutdown()

    @unittest.skipUnless(hasattr(os, "fork"), "needs os.fork")
    def test_the_childs_own_flush_thread_is_recognised_even_when_the_os_reuses_the_thread_ident(self):
        """Regression for the CI failure: glibc may give a thread created in a forked child the pthread_t (Thread.ident) of the
        parent's flush thread, which no longer exists there. Forced here deterministically: every Thread in the child reports exactly the
        parent's flush-thread ident. The OLD check (ident != parent's) then says "no own thread" (the CI failure); the token check must
        still say "own thread", and the SDK must still work."""
        with IngestServer() as server:
            mon = monitor_for(server)
            mon.track(name="parent-event")
            parent_token = mon._thread_token()
            parent_ident = mon._holder.get().thread.ident
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                pid = os.fork()
            if pid == 0:
                try:
                    threading.Thread.ident = property(lambda self: parent_ident)  # a reused pthread_t: same ident as the parent's thread
                    started_empty = mon._queue_len() == 0
                    mon.track(name="child-event")
                    facts = fork_facts(mon, parent_token, started_empty)
                    old_check_would_pass = facts["thread_alive"] and facts["thread_ident"] != parent_ident
                    ok = started_empty and not old_check_would_pass and own_flush_thread(facts) and mon.flush(5)
                    os._exit(0 if ok else 1)
                except BaseException:
                    os._exit(2)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.WEXITSTATUS(status), 0)
            self.assertEqual(server.names(), ["child-event"])
            mon.shutdown()

    def test_the_sdk_never_relies_on_thread_idents(self):
        import glob
        import re

        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "llm_monitor")
        for path in glob.glob(os.path.join(root, "**", "*.py"), recursive=True):
            with open(path, encoding="utf-8") as fh:
                code = re.sub(r"#.*", "", fh.read())
            self.assertNotRegex(code.replace('"""', ""), r"get_ident\(|\.ident\b", path)


if __name__ == "__main__":
    unittest.main()
