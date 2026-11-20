"""Regenerates fixtures/contract_events.json:  python tests/gen_contract_fixtures.py   (from sdk/python)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from contract_cases import build_all  # noqa: E402

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "contract_events.json")


def render():
    return json.dumps({"events": build_all()}, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


if __name__ == "__main__":
    with open(PATH, "w", encoding="utf-8") as f:
        f.write(render())
    print("wrote", PATH)
