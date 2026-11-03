#!/usr/bin/python3
"""Read-only assessment of an optional root-managed release inventory mount.

The view must never be used as a production artifact authority.
No directories, units, mounts, or service state are changed.
"""
import configparser
import json
from pathlib import Path
import stat
import subprocess

UNIT = Path(__file__).resolve().parents[1] / "systemd" / "home-alex-smartresponse-mcp-.releases.mount"
PHYSICAL = Path("/opt/console-mcp-deploy/releases")
VIEW = Path("/home/alex/smartresponse/mcp/.releases")


def ancestor_chain(path):
    chain = []
    cur = path
    while True:
        try:
            st = cur.lstat()
            item = {"path": str(cur), "exists": True, "ownerUid": st.st_uid,
                    "mode": oct(stat.S_IMODE(st.st_mode)),
                    "symlink": stat.S_ISLNK(st.st_mode),
                    "trusted": st.st_uid == 0 and not st.st_mode & 0o022 and not stat.S_ISLNK(st.st_mode)}
        except FileNotFoundError:
            item = {"path": str(cur), "exists": False, "trusted": False}
        except PermissionError:
            item = {"path": str(cur), "exists": True, "trusted": False, "reason": "ACCESS_DENIED"}
        chain.append(item)
        if cur == cur.parent:
            break
        cur = cur.parent
    return chain


def unit_contract(path=UNIT, physical=PHYSICAL, view=VIEW):
    # systemd permits repeated ConditionPathIsDirectory= directives.
    # Reject duplicate [Mount] keys separately so later entries cannot shadow policy.
    lines = path.read_text().splitlines()
    in_mount = False
    mount_keys = set()
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            in_mount = stripped == '[Mount]'
        elif in_mount and stripped and not stripped.startswith('#') and '=' in stripped:
            key = stripped.split('=', 1)[0].strip()
            if key in mount_keys:
                raise RuntimeError('MOUNT_UNIT_DUPLICATE_MOUNT_KEY')
            mount_keys.add(key)
    config = configparser.ConfigParser(interpolation=None, strict=False)
    with path.open() as f:
        config.read_file(f)
    m = config["Mount"]
    options = set(s.strip() for s in m["Options"].split(","))
    if m["What"] != str(physical) or m["Where"] != str(view) or m["Type"] != "none":
        raise RuntimeError("MOUNT_UNIT_UNEXPECTED_PATH")
    if not {"bind", "ro", "nosuid", "nodev", "noexec"} <= options:
        raise RuntimeError("MOUNT_UNIT_WEAK_OPTIONS")
    if "rw" in options or "exec" in options or "remount" in options:
        raise RuntimeError("MOUNT_UNIT_UNSAFE_OPTIONS")
    # Activation must not be coupled with production runtime.
    if "console-mcp.service" in path.read_text():
        raise RuntimeError("MOUNT_UNIT_RUNTIME_COUPLING")
    return {"unitName": path.name, "options": sorted(options), "physical": str(physical),
            "view": str(view)}


def readiness(physical=PHYSICAL, view=VIEW, unit=UNIT):
    contract = unit_contract(unit, physical, view)
    trusted = ancestor_chain(physical)
    visible = ancestor_chain(view)
    return {"status": "MOUNT_VIEW_PLAN_ONLY", "unit": contract,
            "physicalAncestorsTrusted": all(x["trusted"] for x in trusted),
            "viewAncestorsTrusted": all(x["trusted"] for x in visible),
            "physicalAncestors": trusted, "viewAncestors": visible,
            "viewPathReplaceable": any(not x["trusted"] for x in visible),
            "installAuthorized": False, "runtimeCutoverAuthorized": False,
            "serviceRestarted": False, "mountPerformed": False}


if __name__ == "__main__":
    print(json.dumps(readiness(), indent=2))
