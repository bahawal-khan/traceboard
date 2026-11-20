"""Builds ingest events that the server will ACCEPT.

The server validates strictly (lib/ingest/validate.ts) and rejects the WHOLE batch (422) when a single event has an
unknown key, a bad type or a string over its limit. So the SDK sanitises instead of failing: unknown keys and invalid
optional fields are dropped (and counted), over-long free text is truncated, control characters in free text are replaced.
Lengths are measured in UTF-16 code units, like the server (JavaScript string length). Never raises.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

KINDS = ("llm", "tool", "agent", "retrieval", "custom")
STATUSES = ("ok", "error")
MAX_TOKENS = 10_000_000
MAX_LATENCY_MS = 24 * 60 * 60 * 1000
MAX_TAGS = 10
CONTENT_MAX_BYTES = 2_048

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_HEX64 = re.compile(r"[0-9a-f]{64}")
_ISO_TS = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})")

_ID_FIELDS = {"trace_id": 128, "span_id": 128, "parent_id": 128, "thread_id": 128}
_INT_FIELDS = {"input_tokens": MAX_TOKENS, "output_tokens": MAX_TOKENS, "cached_tokens": MAX_TOKENS, "latency_ms": MAX_LATENCY_MS, "ttft_ms": MAX_LATENCY_MS}
_HASH_FIELDS = ("prompt_hash", "args_hash", "user_id_hash")
KNOWN_FIELDS = frozenset(
    {"event_id", "ts", "kind", "name", "model", "provider", "status", "error", "tags", "content"}
    | set(_ID_FIELDS) | set(_INT_FIELDS) | set(_HASH_FIELDS)
)


def _u16len(s: str) -> int:
    """JavaScript string length: astral characters count 2."""
    return len(s) + sum(1 for ch in s if ord(ch) > 0xFFFF)


def _clean(s: str) -> str:
    """Lone surrogates (invalid text) become U+FFFD, exactly one character each, as a UTF-8 round trip does in JavaScript."""
    return _LONE_SURROGATE.sub("�", s)


def _truncate_u16(s: str, limit: int) -> str:
    if _u16len(s) <= limit:
        return s
    out, used = [], 0
    for ch in s:
        w = 2 if ord(ch) > 0xFFFF else 1
        if used + w > limit:
            break
        out.append(ch)
        used += w
    return "".join(out)


def _truncate_bytes(s: str, limit: int) -> str:
    b = s.encode("utf-8", "replace")
    if len(b) <= limit:
        return s
    return b[:limit].decode("utf-8", "ignore")  # "ignore" drops a character cut in half


def _label(value: Any, limit: int) -> Optional[str]:
    """An identifier-like string: used as is or not at all (truncating an id could make two ids collide)."""
    if not isinstance(value, str):
        return None
    value = _clean(value)
    if not value or _u16len(value) > limit or _CONTROL.search(value):
        return None
    return value


def _free_text(value: Any, limit: int) -> Optional[str]:
    """Free text (name, error): control characters become spaces and it is truncated, so it is never rejected."""
    if not isinstance(value, str):
        return None
    value = _CONTROL.sub(" ", _clean(value)).strip()
    value = _truncate_u16(value, limit).strip()
    return value or None


def _int_in_range(value: Any, high: int) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        value = int(round(value))
    if not isinstance(value, int):
        return None
    return value if 0 <= value <= high else None


def format_ts(dt: datetime) -> str:
    """ISO 8601, UTC, millisecond precision, 'Z'. A naive datetime is taken as UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second, dt.microsecond // 1000)


def _event_id(value: Any) -> str:
    if isinstance(value, str):
        try:
            u = uuid.UUID(value)
            if u.variant == uuid.RFC_4122 and u.version is not None and 1 <= u.version <= 8:
                return str(u)
        except ValueError:
            pass
    elif isinstance(value, uuid.UUID) and value.variant == uuid.RFC_4122 and value.version is not None:
        return str(value)
    return str(uuid.uuid4())


def _timestamp(value: Any, now: datetime) -> str:
    if isinstance(value, datetime):
        try:
            return format_ts(value)
        except (OverflowError, ValueError, OSError):
            return format_ts(now)
    if isinstance(value, str) and _ISO_TS.fullmatch(value):
        return value
    return format_ts(now)


def _content(value: Any) -> Optional[Dict[str, str]]:
    if not isinstance(value, dict):
        return None
    out: Dict[str, str] = {}
    for key in ("input", "output"):
        text = value.get(key)
        if isinstance(text, str):
            out[key] = _truncate_bytes(_clean(text), CONTENT_MAX_BYTES)
    return out or None


def build_event(fields: Dict[str, Any], *, capture_content: bool = False, now: Optional[datetime] = None) -> Tuple[Dict[str, Any], int]:
    """Returns (event, number of fields dropped or replaced). The event is always valid for the server."""
    now = now or datetime.now(timezone.utc)
    dropped = 0
    raw_id = fields.get("event_id")
    event_id = _event_id(raw_id)
    if raw_id is not None and event_id != str(raw_id).lower():
        dropped += 1  # an invalid id was replaced by a fresh one
    event: Dict[str, Any] = {"event_id": event_id, "ts": _timestamp(fields.get("ts"), now)}

    kind = fields.get("kind")
    event["kind"] = kind if kind in KINDS else "llm"
    if kind is not None and kind not in KINDS:
        dropped += 1
    status = fields.get("status")
    event["status"] = status if status in STATUSES else "ok"
    if status is not None and status not in STATUSES:
        dropped += 1

    for key, limit in _ID_FIELDS.items():
        if key in fields and fields[key] is not None:
            v = _label(fields[key], limit)
            if v is None:
                dropped += 1
            else:
                event[key] = v
    for key, limit in (("model", 100), ("provider", 50)):
        if key in fields and fields[key] is not None:
            v = _label(fields[key], limit)
            if v is None:
                dropped += 1
            else:
                event[key] = v
    for key, limit in (("name", 200), ("error", 500)):
        if key in fields and fields[key] is not None:
            v = _free_text(fields[key], limit)
            if v is None:
                dropped += 1
            else:
                event[key] = v
    for key, high in _INT_FIELDS.items():
        if key in fields and fields[key] is not None:
            iv = _int_in_range(fields[key], high)
            if iv is None:
                dropped += 1
            else:
                event[key] = iv
    for key in _HASH_FIELDS:
        if key in fields and fields[key] is not None:
            h = fields[key]
            if isinstance(h, str) and _HEX64.fullmatch(h):
                event[key] = h
            else:
                dropped += 1
    if "tags" in fields and fields["tags"] is not None:
        tags = fields["tags"]
        if isinstance(tags, (list, tuple)):
            cleaned = [t for t in (_label(x, 40) for x in tags) if t is not None][:MAX_TAGS]
            if len(cleaned) != len(tags):
                dropped += 1
            if cleaned:
                event["tags"] = cleaned
        else:
            dropped += 1
    if "content" in fields and fields["content"] is not None:
        if capture_content:
            c = _content(fields["content"])
            if c is None:
                dropped += 1
            else:
                event["content"] = c
        # Content capture is OPT-IN: without it the content is silently not sent (that is not an error).

    dropped += sum(1 for k in fields if k not in KNOWN_FIELDS)
    return event, dropped
