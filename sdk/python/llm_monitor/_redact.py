"""Local redaction of captured content, BEFORE it is queued. A port of lib/ingest/redact.ts (the server redacts again,
as defence in depth); tests/fixtures/redaction_cases.json is checked by both implementations so they cannot drift apart.

Heuristic: removes obvious secrets, emails, Luhn-valid card numbers and phone-like digit runs. It cannot find names or free-text
PII, which is why content capture is opt-in. Order matters: secrets, emails, cards, phones.

Regexes use re.ASCII so that \\w and \\b behave like JavaScript's (ASCII only), and an explicit whitespace class equal to JavaScript's \\s.
"""
from __future__ import annotations

import re
from typing import Callable, Dict, List, Optional, Pattern, Tuple

# JavaScript's \s: ASCII whitespace plus these Unicode spaces.
_WS = "\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

_SECRET_PATTERNS: List[Pattern[str]] = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)", re.ASCII),
    re.compile(r"lm_[A-Za-z0-9_-]{16,}", re.ASCII),  # distinctive: matched even when glued to a preceding word
    re.compile(r"\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}", re.ASCII),
    re.compile(r"\bBearer[" + _WS + r"]+[A-Za-z0-9._~+/=-]{16,}", re.ASCII | re.IGNORECASE),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b", re.ASCII),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b", re.ASCII),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}", re.ASCII),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", re.ASCII),
    re.compile(r"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^" + _WS + r"\"']+", re.ASCII | re.IGNORECASE),
]
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}", re.ASCII)
_CARD = re.compile(r"(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])", re.ASCII)
_PHONE = re.compile(r"(?<![\w.-])(?:\+|\()?\d[\d" + _WS + r"().-]{7,}\d(?![\w-])", re.ASCII)

# Redaction runs on at most this many characters (see redact_for_capture): the phone pattern is quadratic on adversarial input
# and runs on the caller's thread. Twice the 2,048-byte content cap, so ordinary shrinking cannot leave the final cut short.
MAX_REDACT_CHARS = 4_096


def _luhn(digits: str) -> bool:
    total, double = 0, False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        double = not double
    return total % 10 == 0


def redact_text(text: str) -> Tuple[str, Dict[str, int]]:
    """Returns (redacted text, counts per kind). Same rules and placeholders as the server."""
    report = {"secret": 0, "email": 0, "card": 0, "phone": 0}

    def count(kind: str, placeholder: str) -> Callable[..., str]:
        def repl(_m: "re.Match[str]") -> str:
            report[kind] += 1
            return placeholder
        return repl

    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(count("secret", "[redacted:secret]"), text)
    text = _EMAIL.sub(count("email", "[redacted:email]"), text)

    def card(m: "re.Match[str]") -> str:
        digits = re.sub(r"[ -]", "", m.group(0))
        if len(digits) < 13 or len(digits) > 19 or not _luhn(digits):
            return m.group(0)
        report["card"] += 1
        return "[redacted:card]"

    def phone(m: "re.Match[str]") -> str:
        digits = len(re.sub(r"\D", "", m.group(0), flags=re.ASCII))
        if digits < 9 or digits > 15:  # dates, versions, short numbers stay
            return m.group(0)
        report["phone"] += 1
        return "[redacted:phone]"

    text = _CARD.sub(card, text)
    text = _PHONE.sub(phone, text)
    return text, report


Redactor = Callable[[str], str]


def make_redactor(custom: Optional[Redactor], builtin: bool) -> Optional[Redactor]:
    """The function applied to every captured text: the user's redactor first (it may know things we cannot), then the built-in
    rules. None means no local redaction at all (the server still redacts)."""
    if custom is None and not builtin:
        return None

    def run(text: str) -> str:
        text = text[:MAX_REDACT_CHARS]  # bound the work (and what a custom redactor is handed) on the caller's thread
        if custom is not None:
            out = custom(text)
            if not isinstance(out, str):
                raise TypeError("a redactor must return a str")
            text = out
        if builtin:
            text = redact_text(text)[0]
        return text

    return run
