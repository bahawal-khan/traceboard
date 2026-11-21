"""Fails CLEARLY, before any test runs, when the interpreter or the provider pins do not fit. Standard library only, and it
must run on the oldest supported Python (no tomllib: pyproject.toml is read with regular expressions).

    python ci/check_environment.py [--require-providers]

Checks: the interpreter is at least `requires-python`; it is listed in the pyproject classifiers (a newer Python is added there
ONLY after the suite passed on it, so an unlisted one is a CI-matrix or classifier mistake); and a pin exists for it in
ci/requirements-providers.txt (or -legacy.txt when LLM_MONITOR_PIN_SET=legacy). With --require-providers the real openai and
anthropic packages must also be importable at exactly the pinned versions."""
from __future__ import annotations

import importlib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tests"))


def fail(message: str) -> None:
    print("::error::" + message)  # a GitHub Actions annotation; plain text elsewhere
    print("ERROR: " + message, file=sys.stderr)
    sys.exit(1)


def main(argv: list) -> int:
    py = sys.version_info
    current = "%d.%d" % (py[0], py[1])
    text = open(os.path.join(ROOT, "pyproject.toml"), encoding="utf-8").read()
    m = re.search(r'^requires-python\s*=\s*">=\s*(\d+)\.(\d+)"', text, re.M)
    if not m:
        fail("pyproject.toml has no `requires-python = \">=X.Y\"` line this script can read")
    minimum = (int(m.group(1)), int(m.group(2)))
    if (py[0], py[1]) < minimum:
        fail("Python %s is older than the supported minimum %d.%d (requires-python in pyproject.toml)" % (current, minimum[0], minimum[1]))
    listed = set(re.findall(r'"Programming Language :: Python :: (3\.\d+)"', text))
    if current not in listed:
        fail("Python %s is not listed in the pyproject.toml classifiers (%s). Either it is not supported yet, or the classifier was "
             "forgotten: add it once the whole suite passes on it, or remove it from the CI matrix." % (current, ", ".join(sorted(listed, key=lambda v: int(v.split('.')[1])))))

    from _real import pinned  # noqa: E402 - needs the sys.path entry above

    pin_file = "requirements-providers-legacy.txt" if os.environ.get("LLM_MONITOR_PIN_SET") == "legacy" else "requirements-providers.txt"
    pins = pinned(pin_file)
    missing = [p for p in ("openai", "anthropic") if p not in pins]
    if missing:
        fail("%s has no pin for %s on Python %s (the newest releases may have dropped it): add a marker line with an older version" % (
            pin_file, " and ".join(missing), current))
    print("Python %s OK (minimum %d.%d); provider pins from %s: %s" % (current, minimum[0], minimum[1], pin_file, pins))

    if "--require-providers" in argv:
        for name in ("openai", "anthropic"):
            try:
                mod = importlib.import_module(name)
            except ImportError as err:
                fail("the real %s package is not importable on Python %s: %s" % (name, current, err))
            if getattr(mod, "__version__", None) != pins[name]:
                fail("%s %s is installed but %s pins %s" % (name, getattr(mod, "__version__", "?"), pin_file, pins[name]))
            print("%s %s imported from the pinned release" % (name, mod.__version__))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
