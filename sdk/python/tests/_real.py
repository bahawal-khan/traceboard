"""Helpers for the tests that run the wrappers against the REAL `openai` / `anthropic` packages (CI job "sdk").

Locally the packages are optional: without them these tests are skipped. In CI the job sets LLM_MONITOR_REQUIRE_REAL_SDKS=1,
and then a missing package, or a package whose version is not the pinned one, is a FAILURE (a skipped test must never look like
a green run). The pins live in ci/requirements-providers.txt (markers by Python version) and ci/requirements-providers-legacy.txt."""
from __future__ import annotations

import importlib
import os
import re
import sys
import unittest
from typing import Any, Dict

HERE = os.path.dirname(os.path.abspath(__file__))
REQUIRE = os.environ.get("LLM_MONITOR_REQUIRE_REAL_SDKS") == "1"


def require(name: str) -> Any:
    """Imports a provider package or skips (locally) / fails (in CI) with a clear message."""
    try:
        return importlib.import_module(name)
    except ImportError as err:
        if REQUIRE:
            raise AssertionError("LLM_MONITOR_REQUIRE_REAL_SDKS=1 but the real %r package is not importable on Python %s: %s" % (
                name, sys.version.split()[0], err))
        raise unittest.SkipTest("the real %r package is not installed (CI installs it; set LLM_MONITOR_REQUIRE_REAL_SDKS=1 to make this an error)" % name)


def pinned(requirements_file: str) -> Dict[str, str]:
    """{package: version} that applies to THIS interpreter from a requirements file with `pkg==x; python_version ...` lines."""
    out: Dict[str, str] = {}
    major_minor = (sys.version_info[0], sys.version_info[1])
    with open(os.path.join(HERE, "..", "ci", requirements_file), encoding="utf-8") as fh:
        for raw in fh:
            line = raw.split("#", 1)[0].strip()
            m = re.match(r"^([A-Za-z0-9_.-]+)==([0-9][0-9A-Za-z.]*)\s*(?:;\s*python_version\s*(<|>=)\s*\"(\d+)\.(\d+)\")?$", line)
            if not m:
                continue
            name, version, op, maj, mnr = m.groups()
            if op is not None:
                bound = (int(maj), int(mnr))
                if (op == "<" and not major_minor < bound) or (op == ">=" and not major_minor >= bound):
                    continue
            out[name.lower()] = version
    return out
