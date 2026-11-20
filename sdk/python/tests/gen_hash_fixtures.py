"""Regenerates fixtures/hash_cases.json:  python tests/gen_hash_fixtures.py   (from sdk/python)."""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from hash_inputs import JSON_CASES, TEXT_CASES  # noqa: E402

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "hash_cases.json")


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def render():
    text = [{"name": n, "input": i, "normalized": norm, "sha256": sha(norm)} for n, i, norm in TEXT_CASES]
    structured = [{"name": n, "value": v, "canonical": c, "sha256": sha(c)} for n, v, c in JSON_CASES]
    return json.dumps({"text": text, "json": structured}, indent=2, ensure_ascii=True, sort_keys=True) + "\n"


if __name__ == "__main__":
    with open(PATH, "w", encoding="utf-8") as f:
        f.write(render())
    print("wrote", PATH)
