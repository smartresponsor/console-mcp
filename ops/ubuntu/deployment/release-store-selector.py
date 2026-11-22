#!/usr/bin/python3
"""Read protected release-storage selector; never trust MCP requests or environment."""
import json
import os
from pathlib import Path

CONTROLLER = Path("/opt/console-mcp-deploy")
LEGACY = CONTROLLER / "releases"
CANONICAL = Path("/home/alex/smartresponse/mcp/.releases")
POLICY = CONTROLLER / "release-store.json"


def check_root_owned(path: Path) -> None:
    current = path
    while True:
        st = current.lstat()
        if current.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError("RELEASE_STORAGE_UNTRUSTED_PATH")
        if current.parent == current:
            break
        current = current.parent


def store(base: Path = CONTROLLER) -> Path:
    """Legacy remains active until a root-approved, complete migration is recorded."""
    base = Path(base)
    policy = base / "release-store.json"
    if not policy.exists():
        return base / "releases"
    check_root_owned(policy)
    document = json.loads(policy.read_text())
    if set(document) != {"schemaVersion", "mode", "artifactRoot", "migrationAdmitted"}:
        raise RuntimeError("RELEASE_STORAGE_POLICY_FIELDS_INVALID")
    if document["schemaVersion"] != 1 or type(document["migrationAdmitted"]) is not bool:
        raise RuntimeError("RELEASE_STORAGE_POLICY_INVALID")
    mode = document["mode"]
    requested = document["artifactRoot"]
    if mode == "legacy" and requested == str(base / "releases"):
        return base / "releases"
    if mode != "canonical" or requested != str(CANONICAL):
        raise RuntimeError("RELEASE_STORAGE_UNRECOGNIZED_ROOT")
    if not document["migrationAdmitted"]:
        raise RuntimeError("RELEASE_STORAGE_MIGRATION_NOT_ADMITTED")
    check_root_owned(CANONICAL)
    if not CANONICAL.is_dir():
        raise RuntimeError("RELEASE_STORAGE_CANONICAL_ROOT_MISSING")
    return CANONICAL
