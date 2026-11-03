#!/usr/bin/python3
"""Read-only complete byte attestation for the active and rollback sealed releases."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

BASE = Path("/opt/console-mcp-deploy")
STORE = BASE / "releases"
REGISTRY = BASE / "registry.json"
UNIT = "console-mcp.service"
SHA = re.compile(r"^[a-f0-9]{40}$")


def attest(directory, identity):
    result = {"identity": identity, "complete": False}
    if not isinstance(identity, str) or SHA.fullmatch(identity) is None:
        return dict(result, reason="NONCANONICAL_SHA_ID")
    tree = directory / identity
    try:
        root_meta = tree.lstat()
        if not stat.S_ISDIR(root_meta.st_mode) or root_meta.st_uid != 0 or root_meta.st_mode & 0o022:
            return dict(result, reason="UNTRUSTED_ROOT")
        manifest = tree / "release.json"
        manifest_meta = manifest.lstat()
        if not stat.S_ISREG(manifest_meta.st_mode) or manifest_meta.st_uid != 0 or manifest_meta.st_mode & 0o022:
            return dict(result, reason="UNTRUSTED_MANIFEST")
        info = json.loads(manifest.read_text())
        expected = info.get("files")
        if not isinstance(expected, dict) or not expected or info.get("sourceCommit") != identity:
            return dict(result, reason="BAD_MANIFEST")
        actual = {}
        for path in tree.rglob("*"):
            rel = path.relative_to(tree).as_posix()
            if rel == "release.json":
                continue
            st = path.lstat()
            if st.st_uid != 0 or (not stat.S_ISLNK(st.st_mode) and st.st_mode & 0o022):
                return dict(result, reason="UNTRUSTED_MEMBER", path=rel)
            if stat.S_ISLNK(st.st_mode):
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(tree.resolve()):
                    return dict(result, reason="ESCAPING_LINK", path=rel)
                actual[rel] = "link:" + os.readlink(path)
            elif stat.S_ISREG(st.st_mode):
                digest = hashlib.sha256()
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                actual[rel] = digest.hexdigest()
            elif not stat.S_ISDIR(st.st_mode):
                return dict(result, reason="SPECIAL_FILE", path=rel)
        if actual != expected:
            return dict(result, reason="HASH_OR_INVENTORY_MISMATCH", expectedCount=len(expected),
                        actualCount=len(actual))
        return dict(result, complete=True, fileCount=len(actual), buildFingerprint=info.get("buildFingerprint"),
                    manifestSha256=hashlib.sha256(manifest.read_bytes()).hexdigest())
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return dict(result, reason=type(exc).__name__)


def systemd_bindings():
    p = subprocess.run(["/usr/bin/systemctl", "show", UNIT, "-p", "MainPID", "-p", "ActiveState",
                        "-p", "BindReadOnlyPaths"], text=True, capture_output=True, check=False, timeout=15)
    if p.returncode:
        raise RuntimeError("SYSTEMD_BINDINGS_UNAVAILABLE")
    values = dict(x.split("=", 1) for x in p.stdout.splitlines() if "=" in x)
    return values


def main():
    reg = json.loads(REGISTRY.read_text())
    loaded = systemd_bindings()
    candidate = reg.get("candidate")
    rollback = reg.get("rollback")
    proof = {"schemaVersion": 1, "mode": "READ_ONLY", "registry": {key: reg.get(key)
             for key in ("candidate", "rollback", "sourceSHA")}, "runtime":
             {key: loaded.get(key) for key in ("MainPID", "ActiveState")}}
    proof["roles"] = {role: attest(STORE, identity) for role, identity
                      in (("candidate", candidate), ("rollback", rollback))}
    expected = str(STORE / candidate / "dist") + ":"
    bound = loaded.get("BindReadOnlyPaths", "")
    proof["activeBindMatchesRegistry"] = bool(isinstance(candidate, str) and
        any(entry.startswith(expected) for entry in bound.split()))
    proof["allHashesVerified"] = all(value["complete"] for value in proof["roles"].values())
    proof["migrationAuthorized"] = False
    print(json.dumps(proof, indent=2))
    if not proof["allHashesVerified"] or not proof["activeBindMatchesRegistry"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
