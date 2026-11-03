#!/usr/bin/python3
"""Read-only live storage readiness: inspect parent ownership and chosen releases."""
import json
import os
from pathlib import Path
import subprocess

HOME = Path("/home/alex/smartresponse/mcp")
TARGET = HOME / ".releases"
LEGACY = Path("/opt/console-mcp-deploy/releases")
REGISTRY = Path("/opt/console-mcp-deploy/registry.json")


def ancestors(path):
    result = []
    current = path
    while True:
        try:
            meta = current.lstat()
            result.append({"path": str(current), "ownerUid": meta.st_uid,
                           "mode": oct(meta.st_mode & 0o777),
                           "symlink": current.is_symlink(),
                           "trusted": not current.is_symlink() and meta.st_uid == 0
                           and not meta.st_mode & 0o022})
        except FileNotFoundError:
            result.append({"path": str(current), "missing": True, "trusted": False})
        except PermissionError:
            result.append({"path": str(current), "inaccessible": True, "trusted": False})
        if current == current.parent:
            break
        current = current.parent
    return result


def live():
    result = subprocess.run(["/usr/bin/systemctl", "show", "console-mcp.service",
                             "-p", "MainPID", "-p", "ActiveState", "-p", "BindReadOnlyPaths"],
                            capture_output=True, text=True, timeout=12, check=False)
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def main():
    registry = json.loads(REGISTRY.read_text())
    selected = {name: registry.get(name) for name in ("candidate", "rollback", "sourceSHA")}
    manifests = {}
    for role in ("candidate", "rollback"):
        identity = selected[role]
        if not isinstance(identity, str) or "/" in identity or identity in (".", ".."):
            raise RuntimeError("UNSAFE_SELECTED_RELEASE_ID")
        path = LEGACY / identity / "release.json"
        manifests[role] = {"identity": identity, "manifestPresent": path.is_file(),
                           "manifestSymlink": path.is_symlink()}
        if path.is_file() and not path.is_symlink():
            d = json.loads(path.read_text())
            manifests[role]["sourceCommit"] = d.get("sourceCommit")
            manifests[role]["inventoryEntries"] = len(d.get("files", {}))
    parents = ancestors(TARGET)
    data = {"status": "READ_ONLY_STORAGE_READINESS", "selected": selected,
            "runtime": live(), "selectedManifests": manifests,
            "canonicalAncestors": parents,
            "canonicalPathTrusted": all(x["trusted"] for x in parents),
            "safeToCutover": False, "filesModified": False}
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
