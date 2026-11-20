"""The SDK must stay importable and correct on Python 3.9: no newer syntax, no newer stdlib modules, no runtime `X | Y`."""
import ast
import glob
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = sorted(glob.glob(os.path.join(ROOT, "llm_monitor", "*.py")))
NEWER_STDLIB = {"tomllib", "compression", "zoneinfo_future"}  # tomllib is 3.11, compression.* is 3.14
NEWER_TYPING = {"Self", "TypeAlias", "ParamSpec", "Concatenate", "TypeGuard", "LiteralString", "Never", "Required", "NotRequired", "Unpack", "TypeVarTuple", "override"}


class TestPython39Compatibility(unittest.TestCase):
    def test_there_are_sources(self):
        self.assertGreaterEqual(len(SOURCES), 6)

    def test_every_module_parses_with_python_3_9_grammar(self):
        for path in SOURCES:
            with open(path, encoding="utf-8") as f:
                ast.parse(f.read(), filename=path, feature_version=(3, 9))  # rejects match, parenthesised with, except*, ...

    def test_no_newer_stdlib_modules_or_typing_names(self):
        for path in SOURCES:
            with open(path, encoding="utf-8") as f:
                tree = ast.parse(f.read())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        self.assertNotIn(alias.name.split(".")[0], NEWER_STDLIB, path)
                if isinstance(node, ast.ImportFrom):
                    self.assertNotIn((node.module or "").split(".")[0], NEWER_STDLIB, path)
                    if node.module == "typing":
                        self.assertFalse(NEWER_TYPING & {a.name for a in node.names}, path)

    def test_no_runtime_union_operator_on_types_or_none(self):
        for path in SOURCES:
            with open(path, encoding="utf-8") as f:
                tree = ast.parse(f.read())
            for node in ast.walk(tree):
                if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
                    for side in (node.left, node.right):
                        self.assertFalse(isinstance(side, ast.Constant) and side.value is None, "%s:%d `X | None`" % (path, node.lineno))

    def test_annotations_are_lazy_in_every_module_that_has_any(self):
        for path in SOURCES:
            with open(path, encoding="utf-8") as f:
                src = f.read()
            if re.search(r"->|: (Optional|Dict|List|Any|int|str|bool|float)\b", src):
                self.assertIn("from __future__ import annotations", src, path)

    def test_no_3_10_plus_only_calls(self):
        for path in SOURCES:
            with open(path, encoding="utf-8") as f:
                src = f.read()
            self.assertNotRegex(src, r"zip\([^)]*strict=", path)
            self.assertNotRegex(src, r"dataclass\([^)]*(slots|kw_only)=", path)
            self.assertNotIn("datetime.UTC", src, path)  # 3.11; use timezone.utc
            self.assertNotRegex(src, r"\bmatch\s+\w+\s*:", path)

    def test_the_declared_python_floor_is_3_9_and_there_are_no_dependencies(self):
        with open(os.path.join(ROOT, "pyproject.toml"), encoding="utf-8") as f:
            toml = f.read()
        self.assertRegex(toml, r'requires-python\s*=\s*">=3\.9"')
        self.assertRegex(toml, r"dependencies\s*=\s*\[\s*\]")


if __name__ == "__main__":
    unittest.main()
