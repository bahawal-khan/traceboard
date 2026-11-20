"""Tiny text helpers shared by event building and hashing."""
from __future__ import annotations

import re

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def clean(s: str) -> str:
    """Lone surrogates (invalid text) become U+FFFD, exactly one character each, as a UTF-8 round trip does in JavaScript.
    (In a Python str a valid astral character is ONE code point, so any surrogate code point is lone.)"""
    return _LONE_SURROGATE.sub("\ufffd", s)
