"""The CI matrix, the pyproject classifiers and the provider pins must agree (no network, no provider packages needed).

A classifier may only claim a Python that CI really tests, and CI may only test a Python the package claims. Skipped when the
repository's workflow file is not next to the sdk (for example when only the sdist is tested)."""
from __future__ import annotations

import os
import re
import unittest

from _real import HERE, pinned

ROOT = os.path.dirname(HERE)
WORKFLOW = os.path.join(ROOT, "..", "..", ".github", "workflows", "ci.yml")


def read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class TestCiConfig(unittest.TestCase):
    def setUp(self):
        if not os.path.exists(WORKFLOW):
            self.skipTest("no .github/workflows/ci.yml next to the sdk")
        self.workflow = read(WORKFLOW)
        self.pyproject = read(os.path.join(ROOT, "pyproject.toml"))

    def matrix_versions(self):
        job = self.workflow.split("\n  sdk-python:", 1)[1] if "\n  sdk-python:" in self.workflow else ""  # the last job of the file
        self.assertTrue(job, "the sdk-python job is missing from ci.yml")
        m = re.search(r"^\s*python:\s*\[([^\]]+)\]", job, re.M)
        self.assertIsNotNone(m, "no `python: [...]` matrix in the sdk-python job")
        return [v.strip().strip("\"'") for v in m.group(1).split(",")]

    def test_the_matrix_equals_the_classifiers_and_starts_at_the_minimum(self):
        versions = self.matrix_versions()
        classifiers = re.findall(r'"Programming Language :: Python :: (3\.\d+)"', self.pyproject)
        self.assertEqual(sorted(versions, key=lambda v: int(v.split(".")[1])), sorted(classifiers, key=lambda v: int(v.split(".")[1])))
        minimum = re.search(r'^requires-python\s*=\s*">=\s*(3\.\d+)"', self.pyproject, re.M).group(1)
        self.assertEqual(min(versions, key=lambda v: int(v.split(".")[1])), minimum)

    def test_every_matrix_python_has_a_pin_for_both_packages(self):
        for version in self.matrix_versions():
            # emulate the marker evaluation for that interpreter
            minor = int(version.split(".")[1])
            lines = [l for l in read(os.path.join(ROOT, "ci", "requirements-providers.txt")).splitlines() if l.strip() and not l.startswith("#")]
            applicable = {l.split("==")[0] for l in lines if ('python_version < "3.10"' in l) == (minor < 10)}
            self.assertEqual(applicable, {"openai", "anthropic"}, version)

    def test_pins_are_exact_and_the_legacy_file_is_the_python39_pair(self):
        for name in ("requirements-providers.txt", "requirements-providers-legacy.txt"):
            for line in read(os.path.join(ROOT, "ci", name)).splitlines():
                if line.strip() and not line.startswith("#"):
                    self.assertRegex(line, r"^(openai|anthropic)==\d+\.\d+\.\d+(;.*)?$", name)
        legacy = {}
        for line in read(os.path.join(ROOT, "ci", "requirements-providers-legacy.txt")).splitlines():
            if "==" in line and not line.startswith("#"):
                legacy[line.split("==")[0]] = line.split("==")[1].strip()
        current_on_39 = {}
        for line in read(os.path.join(ROOT, "ci", "requirements-providers.txt")).splitlines():
            if 'python_version < "3.10"' in line:
                current_on_39[line.split("==")[0]] = line.split("==")[1].split(";")[0].strip()
        self.assertEqual(legacy, current_on_39)

    def test_the_provider_packages_are_never_a_dependency_of_the_sdk(self):
        self.assertIn("dependencies = []", self.pyproject)
        self.assertNotRegex(self.pyproject, r"(?m)^\s*(openai|anthropic)\b")

    def test_the_job_uses_no_secrets(self):
        job = self.workflow.split("\n  sdk-python:", 1)[1]
        self.assertNotIn("secrets.", job)
        self.assertNotIn("api_key", job.lower().replace("llm_monitor", ""))
        self.assertIn("LLM_MONITOR_REQUIRE_REAL_SDKS", job)

    def test_pinned_helper_follows_the_markers_for_this_interpreter(self):
        pins = pinned("requirements-providers.txt")
        import sys
        expected = ("2.48.0", "0.125.0") if sys.version_info < (3, 10) else (pins["openai"], pins["anthropic"])
        self.assertEqual((pins["openai"], pins["anthropic"]), expected)
        self.assertEqual(set(pins), {"openai", "anthropic"})


class TestEnvironmentCheck(unittest.TestCase):
    """ci/check_environment.py fails with a clear message instead of a confusing pip or import error later."""

    def run_check(self, pyproject_edit=None, pins_edit=None, extra_env=None):
        import shutil
        import subprocess
        import sys
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "ci"))
            os.makedirs(os.path.join(tmp, "tests"))
            shutil.copy(os.path.join(ROOT, "ci", "check_environment.py"), os.path.join(tmp, "ci"))
            shutil.copy(os.path.join(ROOT, "tests", "_real.py"), os.path.join(tmp, "tests"))
            for name in ("requirements-providers.txt", "requirements-providers-legacy.txt"):
                text = read(os.path.join(ROOT, "ci", name))
                with open(os.path.join(tmp, "ci", name), "w", encoding="utf-8") as fh:
                    fh.write(pins_edit(text) if pins_edit else text)
            text = read(os.path.join(ROOT, "pyproject.toml"))
            with open(os.path.join(tmp, "pyproject.toml"), "w", encoding="utf-8") as fh:
                fh.write(pyproject_edit(text) if pyproject_edit else text)
            env = dict(os.environ, **(extra_env or {}))
            return subprocess.run([sys.executable, os.path.join(tmp, "ci", "check_environment.py")], capture_output=True, text=True, env=env)

    def test_passes_on_the_current_interpreter(self):
        r = self.run_check()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("OK", r.stdout)

    def test_fails_when_the_interpreter_is_older_than_requires_python(self):
        r = self.run_check(pyproject_edit=lambda t: re.sub(r'requires-python = ">=3\.\d+"', 'requires-python = ">=3.99"', t))
        self.assertEqual(r.returncode, 1)
        self.assertIn("older than the supported minimum 3.99", r.stderr)

    def test_fails_when_the_interpreter_is_not_in_the_classifiers(self):
        import sys

        current = "%d.%d" % sys.version_info[:2]
        r = self.run_check(pyproject_edit=lambda t: t.replace('"Programming Language :: Python :: %s"' % current, '"Programming Language :: Python :: 3.1"'))
        self.assertEqual(r.returncode, 1)
        self.assertIn("is not listed in the pyproject.toml classifiers", r.stderr)

    def test_fails_when_a_pin_for_this_python_is_missing(self):
        r = self.run_check(pins_edit=lambda t: re.sub(r"(?m)^anthropic==.*$", "", t))
        self.assertEqual(r.returncode, 1)
        self.assertIn("has no pin for anthropic", r.stderr)


if __name__ == "__main__":
    unittest.main()
