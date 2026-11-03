#!/usr/bin/python3
"""Nonprivileged tests: never inspect or change production state."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("storage_contract", HERE / "release-storage-contract.py")
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
assert contract.RELEASES.name == ".releases"
assert contract.WORKTREES.name == ".worktrees"
assert contract.RELEASES.parent == contract.WORKTREES.parent
assert contract.release_path("a" * 40) == contract.RELEASES / ("a" * 40)
for invalid in ["short", "A" * 40, "../" + "a" * 40]:
    try:
        contract.release_path(invalid)
        raise AssertionError("invalid SHA accepted")
    except ValueError:
        pass
with tempfile.TemporaryDirectory(prefix="release-store-test-") as tmp:
    t = Path(tmp)
    legacy = t / "legacy"
    legacy.mkdir()
    old = legacy / ("b" * 40)
    old.mkdir()
    (old / "release.json").write_text(json.dumps({"files": {"dist/index.js": "placeholder"}}))
    (legacy / "unverified").mkdir()
    out = subprocess.check_output([sys.executable, "-I", str(HERE / "release-store-audit.py"),
                                   "--legacy-root", str(legacy), "--canonical-root", str(t / "canonical")],
                                  text=True)
    data = json.loads(out)
    assert not data["cutoverAllowed"] and not data["migrationPerformed"]
    assert not (t / "canonical").exists()
    assert len(data["legacyInventory"]["entries"]) == 2
    assert {entry["state"] for entry in data["legacyInventory"]["entries"]} == {"MANIFEST_PRESENT", "NO_MANIFEST"}
print("CANONICAL_RELEASE_STORAGE_CONTRACT_GREEN")
