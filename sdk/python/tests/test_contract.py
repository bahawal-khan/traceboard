import json
import os
import unittest

from contract_cases import build_all
from gen_contract_fixtures import PATH, render


class TestContractFixture(unittest.TestCase):
    def test_the_committed_fixture_is_what_the_sdk_produces_today(self):
        with open(PATH, encoding="utf-8") as f:
            self.assertEqual(f.read(), render(), "run: python tests/gen_contract_fixtures.py (from sdk/python) and commit the result")

    def test_the_fixture_is_a_valid_batch_size_and_covers_the_nasty_cases(self):
        events = build_all()
        self.assertTrue(0 < len(events) <= 100)
        self.assertEqual(len({e["event_id"] for e in events}), len(events))
        self.assertGreaterEqual(len(events), 25)
        self.assertTrue(os.path.exists(PATH))
        json.dumps(events)


if __name__ == "__main__":
    unittest.main()
