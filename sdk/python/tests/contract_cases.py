"""Deliberately nasty inputs. The events the SDK builds from them are written to fixtures/contract_events.json, and
tests/sdk-contract.test.ts (vitest, in the web app) feeds that file to the REAL server schema (lib/ingest/validate.ts).
If the SDK ever produces something the server would reject, one of the two suites fails."""
import uuid
from datetime import datetime, timedelta, timezone

from llm_monitor._events import build_event
from llm_monitor._redact import make_redactor

NOW = datetime(2026, 11, 20, 12, 0, 0, 123456, tzinfo=timezone.utc)
HASH = "0123456789abcdef" * 4
KEY43 = "A" * 43
EMOJI = "\U0001F600"


def cases():
    plus5 = timezone(timedelta(hours=5))
    return [
        {},
        {"kind": "llm", "model": "gpt-4o", "provider": "openai", "input_tokens": 1200, "output_tokens": 300, "cached_tokens": 200, "latency_ms": 830, "ttft_ms": 120},
        {"kind": "tool", "name": "search", "args_hash": HASH, "status": "error", "error": "Traceback (most recent call last):\n  File \"x.py\", line 1\n\tboom\r\n\x00end"},
        {"error": "e" * 5000, "name": "n" * 5000},
        {"name": EMOJI * 150, "error": EMOJI * 400},
        {"name": "lone \ud800 surrogate", "error": "\udfff"},
        {"trace_id": "t" * 128, "span_id": EMOJI * 64, "parent_id": "p", "thread_id": "th-1"},
        {"trace_id": "t" * 129, "span_id": EMOJI * 65, "parent_id": "bad\nid", "thread_id": 42},
        {"input_tokens": 10_000_000, "output_tokens": 0, "latency_ms": 86_400_000, "ttft_ms": 0.4},
        {"input_tokens": 10_000_001, "output_tokens": -1, "latency_ms": float("nan"), "ttft_ms": True, "cached_tokens": "5"},
        {"prompt_hash": HASH, "args_hash": HASH.upper(), "user_id_hash": HASH[:-1]},
        {"tags": ["a", "b", "c"]},
        {"tags": ["t%d" % i for i in range(30)] + ["x" * 41, "bad\ntag", ""]},
        {"ts": datetime(2026, 11, 20, 8, 0, 0, tzinfo=plus5)},
        {"ts": datetime(2026, 11, 20, 12, 0, 0)},
        {"ts": "2026-11-20T11:59:00Z"},
        {"ts": "2026-11-20T11:59:00.5+05:30"},
        {"ts": "not a timestamp"},
        {"event_id": "3F0C1B2E-8A64-4D1F-9C7E-5B2A6D9E1F40"},
        {"event_id": "definitely not a uuid"},
        {"cost_usd": 1.5, "project_id": "p", "received_at": "now", "anything": {"nested": True}},
        {"kind": "agent", "status": "ok", "model": "m" * 100, "provider": "p" * 50},
        {"kind": "nonsense", "status": "nonsense", "model": "m" * 101, "provider": "p" * 51},
        {"content": {"input": "hello", "output": "world"}},
        {"content": {"input": "é" * 3000, "output": EMOJI * 1000}},
        {"content": {"input": "\ud800 lone", "output": "x", "other": "dropped"}},
        {"content": "not a dict"},
        {"prompt": "  Summarise   this\n\ndocument ", "args": {"b": 1, "a": [1, 2]}, "user_id": "user-42"},
        {"prompt": [{"role": "user", "content": "hi"}], "user_id": 42},
        {"prompt": object(), "args": {1, 2}, "user_id": True},
        {"prompt": "p", "prompt_hash": HASH},
        {"status": "error", "error": "User jane@example.com not found; token lm_" + KEY43 + "\n  at line 3"},
        {"content": {"input": "mail jane@example.com card 4111 1111 1111 1111", "output": "call +92 300 1234567"}},
        {"content": {"input": "a" * 2030 + " lm_" + KEY43}},
    ]


def build_all():
    out = []
    for i, fields in enumerate(cases()):
        fields = dict(fields)
        fixed = str(uuid.UUID(int=(0x3F0C1B2E8A644D1F9C7E5B2A6D9E0000 + i), version=4))
        fields.setdefault("event_id", fixed)
        # What the SDK really sends by default: built-in local redaction on, hashing with a fixed test salt.
        event, _ = build_event(fields, capture_content=True, now=NOW, redactor=make_redactor(None, True), hash_salt=b"contract-test-salt")
        if str(fields["event_id"]).lower() != event["event_id"]:
            event["event_id"] = fixed  # the SDK replaced an invalid id with a random uuid4: pin it so the fixture is stable
        out.append(event)
    return out
