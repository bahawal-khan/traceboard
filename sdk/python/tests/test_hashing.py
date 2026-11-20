import hashlib
import hmac
import json
import math
import random
import unittest

from llm_monitor import hash_prompt, hash_text, hash_user_id, hash_value, normalize_text
from gen_hash_fixtures import PATH, render
from hash_inputs import JSON_CASES, TEXT_CASES

HEX64 = r"^[0-9a-f]{64}$"


class TestHashText(unittest.TestCase):
    def test_known_sha256_vectors(self):
        self.assertEqual(hash_text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        self.assertEqual(hash_text(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")

    def test_the_written_normalisation_rules_hold_for_every_case(self):
        for name, raw, normalized in TEXT_CASES:
            self.assertEqual(normalize_text(raw), normalized, name)
            self.assertEqual(hash_text(raw), hashlib.sha256(normalized.encode("utf-8")).hexdigest(), name)

    def test_formatting_does_not_change_the_hash_but_content_does(self):
        self.assertEqual(hash_text("Summarise   this\n\ndocument."), hash_text(" Summarise this document. "))
        self.assertEqual(hash_text("é"), hash_text("é"))  # NFD and NFC are the same text
        self.assertNotEqual(hash_text("Hello"), hash_text("hello"))  # case matters
        self.assertNotEqual(hash_text("a b"), hash_text("a b"))
        self.assertNotEqual(hash_text("a b"), hash_text("ab"))

    def test_output_shape(self):
        self.assertRegex(hash_text("anything"), HEX64)
        self.assertRegex(hash_text("\ud800"), HEX64)  # invalid text never raises

    def test_rejects_non_text(self):
        for bad in (None, 5, b"abc", ["a"]):
            with self.assertRaises(TypeError):
                hash_text(bad)


class TestHashValue(unittest.TestCase):
    def test_the_written_canonical_json_holds_for_every_case(self):
        from llm_monitor._hashing import canonical_json
        for name, value, canonical in JSON_CASES:
            self.assertEqual(canonical_json(value), canonical, name)
            self.assertEqual(hash_value(value), hashlib.sha256(canonical.encode("utf-8")).hexdigest(), name)

    def test_key_order_never_matters(self):
        rnd = random.Random(7)
        keys = ["k%d" % i for i in range(12)]
        base = dict((k, rnd.randint(0, 99)) for k in keys)
        shuffled = dict((k, base[k]) for k in rnd.sample(keys, len(keys)))
        self.assertEqual(hash_value(base), hash_value(shuffled))

    def test_values_that_json_cannot_hold_raise_so_the_caller_can_drop_the_hash(self):
        for bad in (float("nan"), float("inf"), {1, 2}, object(), {(1, 2): 3}, {"a": b"bytes"}):
            with self.assertRaises((TypeError, ValueError)):
                hash_value(bad)

    def test_a_prompt_is_text_or_structured(self):
        self.assertEqual(hash_prompt("  hi  there "), hash_text("hi there"))
        msgs = [{"role": "user", "content": "hi"}]
        self.assertEqual(hash_prompt(msgs), hash_value(msgs))


class TestHashUserId(unittest.TestCase):
    def test_unsalted_is_the_text_hash_and_ints_equal_their_text(self):
        self.assertEqual(hash_user_id("user-1"), hash_text("user-1"))
        self.assertEqual(hash_user_id(42), hash_user_id("42"))

    def test_a_salt_makes_it_an_hmac_that_cannot_be_reproduced_without_it(self):
        salted = hash_user_id("user-1", b"pepper")
        self.assertEqual(salted, hmac.new(b"pepper", b"user-1", hashlib.sha256).hexdigest())
        self.assertNotEqual(salted, hash_user_id("user-1"))
        self.assertNotEqual(salted, hash_user_id("user-1", b"other"))
        self.assertEqual(salted, hash_user_id(" user-1 ", b"pepper"))  # normalised first

    def test_only_str_and_int_are_identifiers(self):
        for bad in (True, None, 1.5, b"x", ["u"], "", "   "):
            with self.assertRaises((TypeError, ValueError)):
                hash_user_id(bad)


class TestFixture(unittest.TestCase):
    def test_the_committed_fixture_is_current(self):
        with open(PATH, encoding="utf-8") as f:
            self.assertEqual(f.read(), render(), "run: python tests/gen_hash_fixtures.py (from sdk/python) and commit the result")

    def test_the_fixture_is_valid_json_with_both_sections(self):
        with open(PATH, encoding="utf-8") as f:
            data = json.load(f)
        self.assertGreaterEqual(len(data["text"]), 10)
        self.assertGreaterEqual(len(data["json"]), 6)
        for c in data["text"] + data["json"]:
            self.assertRegex(c["sha256"], HEX64)
        self.assertTrue(math.isfinite(len(data)))


if __name__ == "__main__":
    unittest.main()
