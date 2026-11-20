import json
import time
import unittest

from llm_monitor import redact_text
from llm_monitor._redact import MAX_REDACT_CHARS, make_redactor
from gen_redaction_fixtures import PATH, build, render

KEY43 = "A" * 43
NBSP = " "


class TestRules(unittest.TestCase):
    def test_emails(self):
        text, report = redact_text("mail jane.doe+x@example.co.uk or bob@corp.io today")
        self.assertEqual(text, "mail [redacted:email] or [redacted:email] today")
        self.assertEqual(report["email"], 2)

    def test_secrets(self):
        for secret in ("lm_" + KEY43, "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", "sk_live_abcdefghijklmnop1234",
                       "Bearer abcdefghijklmnopqrstuvwxyz.0123456789", "AKIAABCDEFGHIJKLMNOP", "ghp_" + "a1" * 20, "xoxb-1234567890-abcdefghij",
                       "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "postgres://user:pw@host.neon.tech/db",
                       "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----"):
            text, report = redact_text("before %s after" % secret)
            self.assertIn("[redacted:secret]", text, secret)
            self.assertNotIn(secret[8:24], text, secret)
            self.assertGreaterEqual(report["secret"], 1, secret)

    def test_cards_need_to_pass_luhn(self):
        self.assertEqual(redact_text("pay 4111 1111 1111 1111 now")[0], "pay [redacted:card] now")
        self.assertEqual(redact_text("card 5500-0000-0000-0004.")[1]["card"], 1)
        self.assertEqual(redact_text("order 1234 5678 9012 3456 ok")[1]["card"], 0)

    def test_phones_but_not_dates_versions_or_short_numbers(self):
        self.assertEqual(redact_text("call +92 300 1234567 please")[0], "call [redacted:phone] please")
        self.assertEqual(redact_text("(555) 123-4567")[0], "[redacted:phone]")
        for keep in ("on 2026-11-20 at 12:30", "ip 10.0.0.1", "v1.2.3.4567", "total 12345", "id 20261120", "abc123456789def"):
            self.assertEqual(redact_text(keep)[0], keep, keep)

    def test_clean_text_is_untouched_and_counts_are_zero(self):
        text, report = redact_text("Summarise the quarterly report in three bullets.")
        self.assertEqual(text, "Summarise the quarterly report in three bullets.")
        self.assertEqual(report, {"secret": 0, "email": 0, "card": 0, "phone": 0})

    def test_javascript_compatible_character_classes(self):
        # \w and \b are ASCII-only (like JavaScript): a key right after a non-ASCII letter is found, after an ASCII letter it is not
        self.assertEqual(redact_text("éAKIAABCDEFGHIJKLMNOP")[0], "é[redacted:secret]")
        self.assertEqual(redact_text("xAKIAABCDEFGHIJKLMNOP")[0], "xAKIAABCDEFGHIJKLMNOP")
        # \s includes the non-breaking space, as in JavaScript
        self.assertEqual(redact_text("+44" + NBSP + "20" + NBSP + "7946" + NBSP + "0958")[0], "[redacted:phone]")
        self.assertEqual(redact_text("bearer" + NBSP + "abcdefghijklmnopqrstuvwx")[0], "[redacted:secret]")


class TestSharedFixture(unittest.TestCase):
    def test_the_committed_fixture_is_what_the_sdk_produces_today(self):
        with open(PATH, encoding="utf-8") as f:
            self.assertEqual(f.read(), render(), "run: python tests/gen_redaction_fixtures.py (from sdk/python) and commit the result")

    def test_every_case_matches_and_redaction_is_idempotent(self):
        with open(PATH, encoding="utf-8") as f:
            cases = json.load(f)["cases"]
        self.assertGreaterEqual(len(cases), 35)
        for c in cases:
            text, report = redact_text(c["input"])
            self.assertEqual((text, report), (c["expected"], c["report"]), c["name"])
            self.assertEqual(redact_text(text)[0], text, c["name"])
        self.assertEqual(len(build()), len(cases))


class TestMakeRedactor(unittest.TestCase):
    def test_none_when_there_is_nothing_to_apply(self):
        self.assertIsNone(make_redactor(None, False))

    def test_builtin_only(self):
        self.assertEqual(make_redactor(None, True)("a@b.co"), "[redacted:email]")

    def test_the_custom_redactor_runs_first_then_the_builtin_rules(self):
        r = make_redactor(lambda t: t.replace("ACME", "jane@example.com"), True)
        self.assertEqual(r("hello ACME"), "hello [redacted:email]")  # the custom output is still redacted
        only_custom = make_redactor(lambda t: t.replace("ACME", "[company]"), False)
        self.assertEqual(only_custom("a@b.co ACME"), "a@b.co [company]")

    def test_a_redactor_that_returns_a_non_string_raises(self):
        with self.assertRaises(TypeError):
            make_redactor(lambda t: 5, False)("x")

    def test_the_input_is_capped_so_the_caller_thread_cannot_be_stalled(self):
        self.assertEqual(len(make_redactor(None, True)("x" * 100_000)), MAX_REDACT_CHARS)
        seen = []
        make_redactor(lambda t: seen.append(len(t)) or t, False)("y" * 100_000)
        self.assertEqual(seen, [MAX_REDACT_CHARS])  # a custom redactor is not handed megabytes either

    def test_hostile_input_is_fast(self):
        # The phone/card patterns are quadratic: 64K digits take ~13 s unbounded. The cap keeps every case in milliseconds.
        r = make_redactor(None, True)
        for text in ("1 " * 500_000 + "a", "1" * 1_000_000, "1-" * 500_000, "a@" * 500_000, "(" * 1_000_000, "lm_" * 300_000,
                     "-----BEGIN PRIVATE KEY-----" * 20_000, "Bearer " + "A" * 1_000_000, "1. " * 400_000):
            started = time.perf_counter()
            r(text)
            self.assertLess(time.perf_counter() - started, 0.5, text[:20])


if __name__ == "__main__":
    unittest.main()
