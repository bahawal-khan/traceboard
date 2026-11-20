"""Regenerates fixtures/redaction_cases.json:  python tests/gen_redaction_fixtures.py   (from sdk/python)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from llm_monitor._redact import redact_text  # noqa: E402
from redaction_inputs import CASES  # noqa: E402

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "redaction_cases.json")


def build():
    out = []
    for name, text in CASES:
        redacted, report = redact_text(text)
        out.append({"name": name, "input": text, "expected": redacted, "report": report})
    return out


def render():
    return json.dumps({"cases": build()}, indent=2, ensure_ascii=True) + "\n"


if __name__ == "__main__":
    with open(PATH, "w", encoding="utf-8") as f:
        f.write(render())
    print("wrote", PATH)
