#!/usr/bin/python3
"""Read-only mount identity admission for an optional .releases view.

The view is NEVER production authority. A successful check is only evidence of a
read-only bind mount in the inspecting process's mount namespace.
"""
import json
from pathlib import Path
import os
import re
import stat

VIEW = Path("/home/alex/smartresponse/mcp/.releases")
PHYSICAL = Path("/opt/console-mcp-deploy/releases")
SHA = re.compile(r"^[0-9a-f]{40}$")


def mountinfo(text):
    """Parse Linux mountinfo preserving mount source and mount-point identity."""
    mounts = []
    for line in text.splitlines():
        if " - " not in line:
            raise ValueError("MOUNTINFO_INVALID_LINE")
        before, after = line.split(" - ", 1)
        fields, fsfields = before.split(), after.split()
        if len(fields) < 6 or len(fsfields) < 3:
            raise ValueError("MOUNTINFO_INVALID_FIELDS")
        mounts.append({"id": int(fields[0]), "parent": int(fields[1]), "device": fields[2],
                       "root": fields[3], "point": fields[4],
                       "mountOptions": fields[5].split(","),
                       "fstype": fsfields[0], "source": fsfields[1],
                       "superOptions": fsfields[2].split(",")})
    return mounts


def mount_at(path, mounts):
    matches = [m for m in mounts if m["point"] == str(path)]
    if len(matches) != 1:
        raise RuntimeError("EXACT_MOUNT_REQUIRED")
    return matches[0]


def inspect(view=VIEW, physical=PHYSICAL, mount_text=None):
    result = {"schemaVersion": 1, "mode": "READ_ONLY", "view": str(view),
              "physical": str(physical), "viewTrustedAsProductionRoot": False,
              "productionCutoverAllowed": False}
    if view.is_symlink() or physical.is_symlink():
        return dict(result, status="SYMLINK_REFUSED")
    if not view.is_dir() or not physical.is_dir():
        return dict(result, status="MOUNT_ENDPOINT_MISSING")
    if mount_text is None:
        mount_text = Path("/proc/self/mountinfo").read_text()
    try:
        mounts = mountinfo(mount_text)
        v = mount_at(view, mounts)
    except (ValueError, RuntimeError):
        return dict(result, status="EXACT_MOUNT_NOT_VERIFIED")
    result["viewMount"] = {k: v[k] for k in ("id", "device", "root", "point", "source", "mountOptions")}
    if "ro" not in v["mountOptions"]:
        return dict(result, status="VIEW_MOUNT_NOT_READ_ONLY")
    try:
        ps, vs = physical.stat(), view.stat()
    except OSError:
        return dict(result, status="MOUNT_STAT_UNAVAILABLE")
    if (ps.st_dev, ps.st_ino) != (vs.st_dev, vs.st_ino):
        return dict(result, status="MOUNT_IDENTITY_MISMATCH")
    # Root owned physical ancestors; view parents deliberately not trusted.
    current = physical
    while True:
        st = current.lstat()
        if stat.S_ISLNK(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            return dict(result, status="PHYSICAL_ANCESTOR_UNTRUSTED", ancestor=str(current))
        if current == current.parent:
            break
        current = current.parent
    return dict(result, status="VIEW_MOUNT_READ_ONLY_VERIFIED",
                viewMountVerified=True,
                warning="Evidence is namespace-local and cannot authorize production path use")


if __name__ == "__main__":
    print(json.dumps(inspect(), indent=2))
