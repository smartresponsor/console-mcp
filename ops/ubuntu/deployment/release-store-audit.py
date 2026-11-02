#!/usr/bin/python3
"""Read-only migration inventory, intentionally never creates or copies directories."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release_storage_contract", HERE / "release-storage-contract.py")
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)


def inspect(root: Path):
    if not root.exists():
        return {"exists": False, "entries": []}
    if root.is_symlink():
        return {"exists": True, "blocked": "SYMLINK_ROOT_REFUSED", "entries": []}
    entries = []
    for p in sorted(root.iterdir()):
        if p.is_symlink():
            entries.append({"id": p.name, "state": "SYMLINK_REFUSED"})
            continue
        if not p.is_dir():
            entries.append({"id": p.name, "state": "NON_DIRECTORY"})
            continue
        manifest = p / "release.json"
        if manifest.is_symlink():
            state = "MANIFEST_SYMLINK_REFUSED"
        elif not manifest.is_file():
            state = "NO_MANIFEST"
        else:
            try:
                data = json.loads(manifest.read_text())
                state = "MANIFEST_PRESENT"
                if not isinstance(data, dict) or not data.get("files"):
                    state = "MANIFEST_INCOMPLETE"
            except (OSError, ValueError):
                state = "MANIFEST_INVALID"
        entries.append({"id": p.name, "state": state,
                        "fullShaName": bool(re.fullmatch("[0-9a-f]{40}", p.name))})
    return {"exists": True, "entries": entries}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-root", type=Path, default=contract.LEGACY_RELEASES)
    parser.add_argument("--canonical-root", type=Path, default=contract.RELEASES)
    args = parser.parse_args()
    layout = contract.check_layout()
    data = {"schemaVersion": 1, "mode": "READ_ONLY", "layout": layout,
            "legacyInventory": inspect(args.legacy_root),
            "canonicalInventory": inspect(args.canonical_root),
            "cutoverAllowed": False, "migrationPerformed": False}
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
