"""Client-side hashing: the platform only ever sees SHA-256 digests of prompts, tool arguments and user ids.

NORMALISATION (so that the same text always gives the same hash, whatever the formatting): Unicode NFC, then every run of ASCII
whitespace (space, tab, newline, carriage return, form feed, vertical tab) becomes one space, then leading and trailing spaces are
removed. Case, punctuation and non-ASCII whitespace (for example U+00A0) are kept. The digest is lowercase hex.
Structured values (chat messages, tool arguments) are hashed as canonical JSON: keys sorted, no spaces, UTF-8, no NaN. Cross-language
equality of structured hashes is only guaranteed for strings, integers, booleans, null, lists and objects (float formatting differs).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import unicodedata
from typing import Any, Optional

from ._text import clean as _clean

_ASCII_WS = re.compile(r"[ \t\n\r\f\v]+")


def normalize_text(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("normalize_text expects a str")
    return _ASCII_WS.sub(" ", unicodedata.normalize("NFC", _clean(text))).strip(" ")


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_text(text: str) -> str:
    """SHA-256 (lowercase hex) of the normalised text."""
    return _digest(normalize_text(text))


def canonical_json(value: Any) -> str:
    """Deterministic JSON. Raises TypeError for values JSON cannot represent and ValueError for NaN/Infinity."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def hash_value(value: Any) -> str:
    """SHA-256 (lowercase hex) of the canonical JSON of a structured value."""
    return _digest(_clean(canonical_json(value)))


def hash_prompt(prompt: Any) -> str:
    """A prompt is usually text (normalised) but may be a list of chat messages (canonical JSON)."""
    return hash_text(prompt) if isinstance(prompt, str) else hash_value(prompt)


def hash_user_id(user_id: Any, salt: Optional[bytes] = None) -> str:
    """User ids are identifiers: str or int. With a salt the digest is an HMAC-SHA-256 keyed by it, so an attacker who knows
    the ids cannot reproduce the hashes without the salt. Raises for anything else."""
    if isinstance(user_id, bool) or not isinstance(user_id, (str, int)):
        raise TypeError("user_id must be a str or an int")
    text = normalize_text(str(user_id))
    if not text:
        raise ValueError("empty user_id")
    if salt:
        return hmac.new(salt, text.encode("utf-8"), hashlib.sha256).hexdigest()
    return _digest(text)
