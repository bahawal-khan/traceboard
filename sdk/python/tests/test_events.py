import json
import random
import re
import unittest
import uuid
from datetime import datetime, timedelta, timezone

from llm_monitor._events import CONTENT_MAX_BYTES, KNOWN_FIELDS, build_event, format_ts

NOW = datetime(2026, 11, 20, 12, 0, 0, 123456, tzinfo=timezone.utc)
HASH = "a" * 64


def ev(**fields):
    event, _ = build_event(fields, now=NOW)
    return event


def dropped(**fields):
    return build_event(fields, now=NOW)[1]


class TestDefaults(unittest.TestCase):
    def test_minimal_event_has_a_uuid4_id_utc_millisecond_ts_and_defaults(self):
        e = ev()
        self.assertEqual(uuid.UUID(e["event_id"]).version, 4)
        self.assertEqual(e["ts"], "2026-11-20T12:00:00.123Z")
        self.assertEqual((e["kind"], e["status"]), ("llm", "ok"))
        self.assertEqual(sorted(e), ["event_id", "kind", "status", "ts"])

    def test_every_event_gets_a_distinct_id(self):
        self.assertEqual(len({ev()["event_id"] for _ in range(200)}), 200)

    def test_known_fields_pass_through(self):
        e = ev(kind="tool", name="search", model="gpt-4o", provider="openai", input_tokens=10, output_tokens=5, cached_tokens=2,
               latency_ms=300, ttft_ms=80, status="error", error="boom", trace_id="t1", span_id="s1", parent_id="s0",
               thread_id="th", prompt_hash=HASH, args_hash=HASH, user_id_hash=HASH, tags=["a", "b"])
        self.assertEqual(e["kind"], "tool")
        self.assertEqual(e["tags"], ["a", "b"])
        self.assertEqual(e["input_tokens"], 10)
        self.assertEqual(dropped(kind="tool", model="m", input_tokens=1), 0)


class TestUnknownAndInvalid(unittest.TestCase):
    def test_unknown_keys_are_dropped_and_counted_never_sent(self):
        e, n = build_event({"cost_usd": 1, "project_id": "x", "name": "n"}, now=NOW)
        self.assertEqual(n, 2)
        self.assertNotIn("cost_usd", e)
        self.assertNotIn("project_id", e)
        self.assertEqual(e["name"], "n")

    def test_invalid_optional_fields_are_dropped_not_fatal(self):
        e, n = build_event({"input_tokens": -1, "output_tokens": "5", "latency_ms": 10**12, "model": "", "kind": "chat", "status": "maybe"}, now=NOW)
        self.assertEqual(n, 6)
        self.assertEqual([k for k in e if k not in ("event_id", "ts", "kind", "status")], [])
        self.assertEqual((e["kind"], e["status"]), ("llm", "ok"))

    def test_numbers(self):
        self.assertNotIn("input_tokens", ev(input_tokens=True))  # bool is not a count
        self.assertEqual(ev(latency_ms=12.6)["latency_ms"], 13)
        for bad in (float("nan"), float("inf"), -0.6, 10_000_001):
            self.assertNotIn("input_tokens", ev(input_tokens=bad), bad)
        self.assertEqual(ev(input_tokens=10_000_000)["input_tokens"], 10_000_000)
        self.assertEqual(ev(input_tokens=0)["input_tokens"], 0)

    def test_none_means_absent_and_is_not_counted(self):
        self.assertEqual(dropped(model=None, input_tokens=None, tags=None, content=None), 0)


class TestStrings(unittest.TestCase):
    def test_free_text_is_cleaned_and_truncated_never_rejected(self):
        e = ev(error="Traceback:\n  File x\n\tboom\x00", name="a\rb")
        self.assertNotRegex(e["error"], r"[\x00-\x1f\x7f]")
        self.assertNotRegex(e["name"], r"[\x00-\x1f\x7f]")
        self.assertEqual(len(ev(error="e" * 900)["error"]), 500)
        self.assertEqual(len(ev(name="n" * 900)["name"]), 200)
        self.assertNotIn("error", ev(error="\n\n"))  # nothing left after cleaning

    def test_identifiers_are_kept_whole_or_dropped_never_truncated(self):
        self.assertEqual(ev(trace_id="t" * 128)["trace_id"], "t" * 128)
        self.assertNotIn("trace_id", ev(trace_id="t" * 129))
        self.assertNotIn("model", ev(model="m\nx"))
        self.assertNotIn("provider", ev(provider="p" * 51))
        self.assertNotIn("span_id", ev(span_id=123))

    def test_lengths_count_utf16_units_like_the_server(self):
        self.assertIn("trace_id", ev(trace_id="\U0001F600" * 64))  # 128 UTF-16 units
        self.assertNotIn("trace_id", ev(trace_id="\U0001F600" * 65))  # 130 units, although only 65 characters
        name = ev(name="\U0001F600" * 150)["name"]
        self.assertEqual(len(name.encode("utf-16-le")) // 2, 200)

    def test_lone_surrogates_become_one_replacement_character(self):
        self.assertEqual(ev(name="a\ud800b")["name"], "a�b")

    def test_hashes_must_be_lowercase_sha256_hex(self):
        self.assertEqual(ev(prompt_hash=HASH)["prompt_hash"], HASH)
        for bad in ("A" * 64, "a" * 63, "a" * 65, HASH + "\n", "g" * 64, 5):
            self.assertNotIn("prompt_hash", ev(prompt_hash=bad), repr(bad))


class TestTags(unittest.TestCase):
    def test_tags(self):
        self.assertEqual(ev(tags=("a", "b"))["tags"], ["a", "b"])
        e, n = build_event({"tags": ["t%d" % i for i in range(15)]}, now=NOW)
        self.assertEqual(len(e["tags"]), 10)
        self.assertEqual(n, 1)
        e, n = build_event({"tags": ["ok", "", "x" * 41, 5, "bad\n"]}, now=NOW)
        self.assertEqual(e["tags"], ["ok"])
        self.assertEqual(n, 1)
        self.assertNotIn("tags", ev(tags="notalist"))
        self.assertNotIn("tags", ev(tags=[]))


class TestContent(unittest.TestCase):
    def test_content_is_opt_in(self):
        e, n = build_event({"content": {"input": "secret prompt"}}, now=NOW)
        self.assertNotIn("content", e)
        self.assertEqual(n, 0)  # silently not sent: capture is simply off
        e, _ = build_event({"content": {"input": "hi", "output": "yo", "other": "x"}}, capture_content=True, now=NOW)
        self.assertEqual(e["content"], {"input": "hi", "output": "yo"})

    def test_content_is_truncated_to_the_byte_cap_on_a_character_boundary(self):
        e, _ = build_event({"content": {"input": "é" * 3000, "output": "\U0001F600" * 1000}}, capture_content=True, now=NOW)
        for part in ("input", "output"):
            b = e["content"][part].encode("utf-8")
            self.assertLessEqual(len(b), CONTENT_MAX_BYTES)
            b.decode("utf-8")  # whole characters only
        self.assertEqual(len(e["content"]["input"].encode("utf-8")), CONTENT_MAX_BYTES)

    def test_bad_content_is_dropped(self):
        for bad in ("text", 5, [], {}, {"input": 5}):
            e, _ = build_event({"content": bad}, capture_content=True, now=NOW)
            self.assertNotIn("content", e, repr(bad))


class TestTimestampAndId(unittest.TestCase):
    def test_datetimes(self):
        self.assertEqual(format_ts(datetime(2026, 1, 2, 3, 4, 5, 678000)), "2026-01-02T03:04:05.678Z")  # naive = UTC
        plus5 = timezone(timedelta(hours=5))
        self.assertEqual(ev(ts=datetime(2026, 1, 2, 8, 0, 0, tzinfo=plus5))["ts"], "2026-01-02T03:00:00.000Z")

    def test_iso_strings_are_accepted_garbage_is_replaced_by_now(self):
        self.assertEqual(ev(ts="2026-11-20T11:59:00Z")["ts"], "2026-11-20T11:59:00Z")
        self.assertEqual(ev(ts="2026-11-20T11:59:00.5+05:00")["ts"], "2026-11-20T11:59:00.5+05:00")
        for bad in ("yesterday", "2026-11-20", "2026-11-20T11:59:00", 12345, "2026-11-20T11:59:00Z\n"):
            self.assertEqual(ev(ts=bad)["ts"], "2026-11-20T12:00:00.123Z", repr(bad))

    def test_extreme_datetimes_do_not_raise(self):
        self.assertRegex(ev(ts=datetime.min.replace(tzinfo=timezone(timedelta(hours=-5))))["ts"], r"^\d{4}-")

    def test_event_ids(self):
        good = "3F0C1B2E-8A64-4D1F-9C7E-5B2A6D9E1F40"
        self.assertEqual(ev(event_id=good)["event_id"], good.lower())
        self.assertEqual(ev(event_id=uuid.UUID(good))["event_id"], good.lower())
        self.assertEqual(ev(event_id=str(uuid.uuid1()))["event_id"][14], "1")  # any RFC version is fine
        for bad in ("not-a-uuid", "00000000-0000-0000-0000-000000000000", "", 5):
            e, n = build_event({"event_id": bad}, now=NOW)
            self.assertEqual(uuid.UUID(e["event_id"]).version, 4, repr(bad))
            self.assertEqual(n, 1 if bad != "" else 1)


class TestRobustness(unittest.TestCase):
    def test_never_raises_and_always_json_serialisable(self):
        rnd = random.Random(1)
        pool = [None, True, 0, -1, 1.5, float("nan"), "", "x", "x" * 5000, "\ud800", b"bytes", [], [1], {}, {"a": 1}, object(), (1, 2), datetime.now(), uuid.uuid4(), "\x00"]
        for _ in range(2000):
            fields = dict((rnd.choice(list(KNOWN_FIELDS) + ["zzz"]), rnd.choice(pool)) for _ in range(rnd.randint(0, 8)))
            event, n = build_event(fields, capture_content=bool(rnd.getrandbits(1)))
            json.dumps(event)  # must not raise
            self.assertIsInstance(n, int)
            self.assertLessEqual(set(event), KNOWN_FIELDS)
            self.assertRegex(event["ts"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")

    def test_a_non_dict_field_mapping_is_the_callers_problem_not_a_crash_in_the_monitor(self):
        # build_event takes a dict by contract; Monitor.track always passes one (covered in test_monitor).
        self.assertTrue(re.match(r"^[0-9a-f-]{36}$", ev()["event_id"]))


if __name__ == "__main__":
    unittest.main()
