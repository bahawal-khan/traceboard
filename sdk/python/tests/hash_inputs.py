"""Hand-written expectations for hashing. `normalized` / `canonical` are written BY HAND, not computed, so the test checks the
implementation against the written rule; the digests in fixtures/hash_cases.json are computed from them with hashlib. A future JS
SDK (Phase 8) must reproduce this file exactly."""
NBSP = " "

TEXT_CASES = [
    ("empty", "", ""),
    ("plain", "abc", "abc"),
    ("outer whitespace", "  hello world \n", "hello world"),
    ("inner runs", "a  b\t\tc\n\nd\r\ne\ff\vg", "a b c d e f g"),
    ("case is kept", "Hello HELLO hello", "Hello HELLO hello"),
    ("punctuation is kept", "a , b . c", "a , b . c"),
    ("nbsp is not collapsed", "a" + NBSP + "b", "a" + NBSP + "b"),
    ("nfd becomes nfc", "é", "é"),
    ("already nfc", "é", "é"),
    ("cjk and emoji", "日本語  \U0001F600", "日本語 \U0001F600"),
    ("lone surrogate becomes U+FFFD", "a\ud800b", "a�b"),
    ("only whitespace", " \t\n ", ""),
]

# (name, value, canonical json written by hand)
JSON_CASES = [
    ("empty object", {}, "{}"),
    ("keys are sorted", {"b": 1, "a": 2}, '{"a":2,"b":1}'),
    ("nested and ordered", {"z": [3, {"y": None, "x": True}], "a": "s"}, '{"a":"s","z":[3,{"x":true,"y":null}]}'),
    ("unicode is not escaped", {"k": "é日"}, '{"k":"é日"}'),
    ("chat messages", [{"role": "user", "content": "hi"}], '[{"content":"hi","role":"user"}]'),
    ("integers", [1, -2, 0], "[1,-2,0]"),
    ("strings keep their whitespace", {"a": "x  y"}, '{"a":"x  y"}'),
]
