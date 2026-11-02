#!/usr/bin/python3
"""Fail-closed tests for the protected storage selector; no production mutation."""
import importlib.util
import json
from pathlib import Path
import tempfile

p = Path(__file__).with_name("release-store-selector.py")
spec = importlib.util.spec_from_file_location("release_selector_test", p)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix="release-selector-test-") as temp:
    base = Path(temp) / "control"
    base.mkdir()
    assert m.store(base) == base / "releases"
    policy = base / "release-store.json"
    def set_policy(mode, root, admitted):
        policy.write_text(json.dumps({"schemaVersion": 1, "mode": mode,
                                      "artifactRoot": str(root), "migrationAdmitted": admitted}))
    set_policy("legacy", base / "releases", False)
    try:
        m.store(base)
    except RuntimeError as exc:
        assert str(exc) == "RELEASE_STORAGE_UNTRUSTED_PATH"
    else:
        raise AssertionError("mutable policy should be refused")
    # Isolate semantic checks from ownership/mode checks only in a fixture.
    m.check_root_owned = lambda path: None
    assert m.store(base) == base / "releases"
    set_policy("canonical", m.CANONICAL, False)
    try:
        m.store(base)
    except RuntimeError as exc:
        assert str(exc) == "RELEASE_STORAGE_MIGRATION_NOT_ADMITTED"
    else:
        raise AssertionError("unadmitted migration accepted")
    set_policy("custom", base / "foo", True)
    try:
        m.store(base)
    except RuntimeError as exc:
        assert str(exc) == "RELEASE_STORAGE_UNRECOGNIZED_ROOT"
    else:
        raise AssertionError("arbitrary artifact root accepted")
    set_policy("canonical", m.CANONICAL, True)
    try:
        m.store(base)
    except RuntimeError as exc:
        assert str(exc) == "RELEASE_STORAGE_CANONICAL_ROOT_MISSING"
    else:
        raise AssertionError("missing canonical root accepted")
print("RELEASE_STORAGE_SELECTOR_FAIL_CLOSED_GREEN")
