"""The privacy pipeline end to end: raw values are hashed and forgotten, captured content is redacted locally (fail closed) before
it is queued, and none of it can reach the queue, the wire, the stats or the logs in the clear."""
import hashlib
import hmac
import json
import multiprocessing
import os
import pickle
import random
import unittest
import warnings

from llm_monitor import Monitor, hash_text, hash_value
from _helpers import API_KEY, FakeTransport, IngestServer, child_track_private, redact_acme, wait_until

URL = "https://monitor.example.com"
SENTINEL_PROMPT = "SENTINEL-PROMPT-TEXT"
SENTINEL_EMAIL = "sentinel.person@example.com"


def make(transport=None, **options):
    options.setdefault("min_flush_interval_ms", 20)
    options.setdefault("flush_interval_ms", 60_000)
    return Monitor(API_KEY, URL, transport=transport if transport is not None else FakeTransport(), **options)


def everything_visible(mon, fake):
    """Every place a raw value could leak to: the queue, what was handed to the transport, the stats, the repr."""
    queued = [it.event for it in mon._holder.core.queue._items]
    return json.dumps([queued, fake.all_events(), mon.stats, repr(mon)], default=str)


class TestHashedInputs(unittest.TestCase):
    def test_raw_prompt_args_and_user_id_become_hashes_and_are_never_kept(self):
        fake = FakeTransport()
        mon = make(fake)
        mon.track(name="x", prompt=SENTINEL_PROMPT + "  with   spaces", args={"q": SENTINEL_EMAIL, "n": 3}, user_id="user-SENTINEL")
        visible = everything_visible(mon, fake)  # still queued
        mon.flush()
        visible += everything_visible(mon, fake)  # and after sending
        (event,) = fake.all_events()
        self.assertEqual(event["prompt_hash"], hash_text(SENTINEL_PROMPT + " with spaces"))
        self.assertEqual(event["args_hash"], hash_value({"n": 3, "q": SENTINEL_EMAIL}))
        self.assertEqual(event["user_id_hash"], hash_text("user-SENTINEL"))
        for raw in (SENTINEL_PROMPT, SENTINEL_EMAIL, "user-SENTINEL"):
            self.assertNotIn(raw, visible)
        for key in ("prompt", "args", "user_id"):
            self.assertNotIn(key, event)
        mon.shutdown()

    def test_chat_messages_are_hashed_as_structured_values(self):
        fake = FakeTransport()
        mon = make(fake)
        msgs = [{"role": "user", "content": "hello"}]
        mon.track(prompt=msgs)
        mon.flush()
        self.assertEqual(fake.all_events()[0]["prompt_hash"], hash_value(msgs))
        mon.shutdown()

    def test_the_salt_keys_the_user_hash_only(self):
        fake = FakeTransport()
        mon = make(fake, hash_salt="pepper")
        mon.track(user_id="u1", prompt="p")
        mon.flush()
        (event,) = fake.all_events()
        self.assertEqual(event["user_id_hash"], hmac.new(b"pepper", b"u1", hashlib.sha256).hexdigest())
        self.assertEqual(event["prompt_hash"], hash_text("p"))  # prompts stay comparable across processes
        self.assertNotIn("pepper", everything_visible(mon, fake))
        mon.shutdown()

    def test_an_explicit_hash_wins_over_a_raw_value(self):
        fake = FakeTransport()
        mon = make(fake)
        explicit = "ab" * 32
        mon.track(prompt="ignored", prompt_hash=explicit)
        mon.flush()
        self.assertEqual(fake.all_events()[0]["prompt_hash"], explicit)
        mon.shutdown()

    def test_unhashable_inputs_are_dropped_counted_and_never_raise(self):
        mon = make()
        mon.track(prompt=object(), args={1, 2}, user_id=True)
        mon.track(args=float("nan"), user_id="")
        s = mon.stats
        self.assertEqual((s["events_tracked"], s["fields_dropped"], s["errors"]), (2, 5, 0))
        self.assertNotIn("prompt_hash", mon._holder.core.queue._items[0].event)
        mon.shutdown(0)

    def test_the_raw_input_names_are_not_counted_as_unknown_fields(self):
        mon = make()
        mon.track(prompt="p", args={"a": 1}, user_id="u")
        self.assertEqual(mon.stats["fields_dropped"], 0)
        mon.shutdown(0)

    def test_bad_salt_types_disable_the_sdk_and_empty_means_none(self):
        for bad in (5, ["x"], object()):
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)  # "llm_monitor is disabled" is the expected announcement
                mon = make(hash_salt=bad)
            self.assertFalse(mon.enabled, bad)
            self.assertIn("hash_salt", mon.config_error)
        mon = make(hash_salt="")
        self.assertTrue(mon.enabled)
        self.assertIsNone(mon._holder.core.cfg.hash_salt)
        mon.shutdown(0)


class TestLocalRedaction(unittest.TestCase):
    def sent_content(self, **options):
        fake = FakeTransport()
        mon = make(fake, capture_content=True, **options)
        mon.track(name="c", content={"input": "mail %s key lm_%s" % (SENTINEL_EMAIL, "A" * 43), "output": "card 4111 1111 1111 1111"})
        mon.flush()
        content = fake.all_events()[0].get("content")
        visible = everything_visible(mon, fake)
        mon.shutdown()
        return content, visible

    def test_captured_content_is_redacted_before_it_is_queued_by_default(self):
        content, visible = self.sent_content()
        self.assertEqual(content["input"], "mail [redacted:email] key [redacted:secret]")
        self.assertEqual(content["output"], "card [redacted:card]")
        self.assertNotIn(SENTINEL_EMAIL, visible)
        self.assertNotIn("4111 1111", visible)

    def test_it_can_be_switched_off_the_server_then_still_redacts(self):
        content, _ = self.sent_content(redact_content=False)
        self.assertIn(SENTINEL_EMAIL, content["input"])

    def test_redaction_happens_before_truncation_so_a_secret_at_the_cap_is_removed_whole(self):
        fake = FakeTransport()
        mon = make(fake, capture_content=True)
        mon.track(content={"input": "a" * 2030 + " lm_" + "Z" * 43})
        mon.flush()
        text = fake.all_events()[0]["content"]["input"]
        self.assertNotIn("lm_Z", text)
        self.assertTrue(text.endswith("[redacted:secret]"))
        mon.shutdown()

    def test_content_that_is_not_captured_is_never_looked_at(self):
        calls = []
        fake = FakeTransport()
        mon = make(fake, capture_content=False, redactor=lambda t: calls.append(t) or t)
        mon.track(content={"input": SENTINEL_EMAIL})
        mon.flush()
        self.assertEqual(calls, [])
        self.assertNotIn("content", fake.all_events()[0])
        self.assertNotIn(SENTINEL_EMAIL, everything_visible(mon, fake))
        mon.shutdown()

    def test_a_custom_redactor_runs_first_then_the_builtin_rules(self):
        fake = FakeTransport()
        mon = make(fake, capture_content=True, redactor=lambda t: t.replace("ACME", SENTINEL_EMAIL))
        mon.track(content={"input": "hello ACME"})
        mon.flush()
        self.assertEqual(fake.all_events()[0]["content"]["input"], "hello [redacted:email]")
        mon.shutdown()

    def test_a_raising_redactor_drops_the_content_and_sends_nothing_raw(self):
        fake = FakeTransport()

        def broken(text):
            raise RuntimeError("redactor bug while handling " + text)

        mon = make(fake, capture_content=True, redactor=broken)
        mon.track(name="still-sent", content={"input": SENTINEL_EMAIL, "output": "x"})
        mon.flush()
        (event,) = fake.all_events()
        self.assertEqual(event["name"], "still-sent")  # the event itself is kept
        self.assertNotIn("content", event)  # FAIL CLOSED: no content at all
        s = mon.stats
        self.assertEqual((s["redaction_errors"], s["errors"]), (1, 0))
        self.assertNotIn(SENTINEL_EMAIL, everything_visible(mon, fake))  # the exception text (with the content) is not recorded
        mon.shutdown()

    def test_a_redactor_returning_the_wrong_type_also_fails_closed(self):
        for bad_return in (None, 5, b"bytes", ["x"]):
            fake = FakeTransport()
            mon = make(fake, capture_content=True, redactor=lambda t, r=bad_return: r)
            mon.track(content={"input": SENTINEL_EMAIL})
            mon.flush()
            self.assertNotIn("content", fake.all_events()[0], bad_return)
            self.assertEqual(mon.stats["redaction_errors"], 1, bad_return)
            mon.shutdown()

    def test_the_error_field_is_redacted_too_even_without_content_capture(self):
        fake = FakeTransport()
        mon = make(fake)  # capture_content is OFF
        mon.track(name="call", status="error", error="User %s not found; token lm_%s\n  at line 3" % (SENTINEL_EMAIL, "A" * 43))
        mon.flush()
        self.assertEqual(fake.all_events()[0]["error"], "User [redacted:email] not found; token [redacted:secret]   at line 3")  # the newline became a space
        self.assertNotIn(SENTINEL_EMAIL, everything_visible(mon, fake))
        mon.shutdown()

    def test_a_failing_redactor_drops_the_error_text_not_the_event(self):
        fake = FakeTransport()
        mon = make(fake, redactor=lambda t: 1 / 0)
        mon.track(name="call", status="error", error=SENTINEL_EMAIL)
        mon.flush()
        (event,) = fake.all_events()
        self.assertEqual((event["name"], event["status"]), ("call", "error"))
        self.assertNotIn("error", event)
        self.assertEqual(mon.stats["redaction_errors"], 1)
        self.assertNotIn(SENTINEL_EMAIL, everything_visible(mon, fake))
        mon.shutdown()

    def test_the_error_field_is_left_alone_when_the_builtin_rules_are_off_and_there_is_no_custom_redactor(self):
        fake = FakeTransport()
        mon = make(fake, redact_content=False)
        mon.track(error="plain failure")
        mon.flush()
        self.assertEqual(fake.all_events()[0]["error"], "plain failure")
        mon.shutdown()

    def test_a_non_callable_redactor_disables_the_sdk_rather_than_weakening_redaction(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            mon = make(capture_content=True, redactor="not callable")
        self.assertFalse(mon.enabled)
        self.assertIn("redactor", mon.config_error)
        self.assertIsNone(mon.track(content={"input": SENTINEL_EMAIL}))

    def test_huge_content_is_cut_cheaply_and_never_stalls_track(self):
        import time
        mon = make(capture_content=True)
        started = time.perf_counter()
        mon.track(content={"input": "1 " * 2_000_000 + "a", "output": "x" * 5_000_000})
        self.assertLess(time.perf_counter() - started, 1.0)
        mon.shutdown(0)

    def test_fuzz_never_raises_and_never_leaks_the_sentinel(self):
        rnd = random.Random(3)
        pool = [None, True, 5, 1.5, "", SENTINEL_EMAIL, "x" * 9000, "\ud800", b"b", [SENTINEL_EMAIL], {"input": SENTINEL_EMAIL}, {"input": 5}, {"output": ["x"]}, object()]
        for redactor in (None, lambda t: t.upper(), lambda t: 1 / 0):
            fake = FakeTransport()
            mon = make(fake, capture_content=True, redactor=redactor)
            for _ in range(300):
                mon.track(content=rnd.choice(pool), prompt=rnd.choice(pool), args=rnd.choice(pool), user_id=rnd.choice(pool), error=rnd.choice(pool))
            mon.flush(timeout=10)
            blob = json.dumps(fake.all_events(), default=str)
            self.assertNotIn(SENTINEL_EMAIL, blob)
            self.assertNotIn(SENTINEL_EMAIL.upper(), blob)
            mon.shutdown(0)


class TestOverRealHttp(unittest.TestCase):
    def test_what_crosses_the_wire_is_hashed_and_redacted(self):
        with IngestServer() as server:
            mon = Monitor(API_KEY, server.url, capture_content=True, hash_salt="s", flush_interval_ms=60_000, min_flush_interval_ms=20)
            mon.track(name="w", prompt=SENTINEL_PROMPT, user_id="alice", content={"input": "hi " + SENTINEL_EMAIL})
            self.assertTrue(mon.flush(timeout=5))
            wire = server.requests[0]["raw"].decode("utf-8")
            for raw in (SENTINEL_PROMPT, SENTINEL_EMAIL, "alice"):
                self.assertNotIn(raw, wire)
            event = server.events()[0]
            self.assertEqual(event["content"]["input"], "hi [redacted:email]")
            self.assertEqual(event["user_id_hash"], hmac.new(b"s", b"alice", hashlib.sha256).hexdigest())
            mon.shutdown()


class TestPicklingKeepsRedaction(unittest.TestCase):
    def test_a_redactor_that_cannot_be_pickled_makes_pickling_fail_loudly(self):
        mon = make(capture_content=True, redactor=lambda t: t)
        with self.assertRaises(pickle.PicklingError) as ctx:
            pickle.dumps(mon)
        self.assertIn("llm_monitor: the custom redactor cannot be pickled", str(ctx.exception))  # our message, not Python's
        self.assertNotIn(API_KEY, str(ctx.exception))
        mon.shutdown(0)

    def test_a_module_level_redactor_and_the_salt_survive_a_pickle_round_trip(self):
        mon = make(capture_content=True, redactor=redact_acme, hash_salt="pepper")
        clone = pickle.loads(pickle.dumps(mon))
        cfg = clone._holder.core.cfg
        self.assertIs(cfg.redactor, redact_acme)
        self.assertEqual(cfg.hash_salt, b"pepper")
        self.assertEqual(clone._holder.core.redactor("ACME x@y.co"), "[company] [redacted:email]")
        mon.shutdown(0)
        clone.shutdown(0)

    def test_without_a_custom_redactor_nothing_extra_is_required(self):
        mon = make(capture_content=True)
        pickle.dumps(mon)
        mon.shutdown(0)

    def test_a_child_process_applies_the_same_redaction_and_hashing(self):
        methods = [m for m in ("fork", "forkserver") if m in multiprocessing.get_all_start_methods()]
        self.assertTrue(methods)
        for method in methods:
            with self.subTest(method=method), IngestServer() as server:
                mon = Monitor(API_KEY, server.url, capture_content=True, redactor=redact_acme, hash_salt="pepper", flush_interval_ms=60_000, min_flush_interval_ms=20)
                ctx = multiprocessing.get_context(method)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", DeprecationWarning)
                    proc = ctx.Process(target=child_track_private, args=(mon, "alice"))
                    proc.start()
                proc.join(60)
                self.assertEqual(proc.exitcode, 0)
                (event,) = server.events()
                self.assertEqual(event["content"]["input"], "[company] mail [redacted:email]")  # custom first, then built-in
                self.assertEqual(event["user_id_hash"], hmac.new(b"pepper", b"alice", hashlib.sha256).hexdigest())
                wire = server.requests[0]["raw"].decode("utf-8")
                for raw in ("jane@example.com", "alice", "the secret prompt", "ACME"):
                    self.assertNotIn(raw, wire, method)
                mon.shutdown(0)


if __name__ == "__main__":
    unittest.main()
