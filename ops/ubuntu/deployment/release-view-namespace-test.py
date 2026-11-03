#!/usr/bin/python3
"""Fail-closed kernel mount namespace test with scratch-only paths.

Never performs mounts in the caller namespace. An unavailable user namespace is
a blocker, not a passing or skipped security gate.
"""
import json
import subprocess
import sys

WORKER = r'''
import json, os, pathlib, subprocess, tempfile
with tempfile.TemporaryDirectory(prefix="release-view-mntns-") as tmp:
    root = pathlib.Path(tmp)
    physical, parent = root / "physical", root / "operator-owned"
    physical.mkdir()
    parent.mkdir()
    view = parent / ".releases"
    view.mkdir()
    (physical / "sentinel").write_text("sealed")
    subprocess.run(["/usr/bin/mount", "--bind", str(physical), str(view)], check=True, timeout=8)
    subprocess.run(["/usr/bin/mount", "-o", "remount,bind,ro,nosuid,nodev,noexec", str(view)], check=True, timeout=8)
    assert (view / "sentinel").read_text() == "sealed"
    options = subprocess.check_output(["/usr/bin/findmnt", "-n", "-o", "OPTIONS", "--target", str(view)], text=True).strip().split(",")
    assert "ro" in options and "nosuid" in options and "nodev" in options and "noexec" in options
    try:
        (view / "injection").write_text("tamper")
        raise AssertionError("read-only bind mount allowed write")
    except OSError:
        pass
    # A rename attack might fail because the mountpoint is busy. It MUST NOT
    # grant a second trusted identity through this mutable path.
    rename = "DENIED"
    try:
        view.rename(parent / ".releases-moved")
        rename = "SUCCEEDED"
    except OSError:
        pass
    print(json.dumps({"isolatedNamespace": True, "readOnlyBindVerified": True,
                      "renameAttempt": rename, "productionRootTrusted": False}))
'''


def test():
    argv = ["/usr/bin/unshare", "--user", "--map-root-user", "--mount", "--fork",
            "--", sys.executable, "-I", "-c", WORKER]
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=25, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"status": "KERNEL_NAMESPACE_TEST_BLOCKED", "reason": type(error).__name__,
                "gatePassed": False, "productionCutoverAuthorized": False}
    if r.returncode:
        return {"status": "KERNEL_NAMESPACE_TEST_BLOCKED" if
                "Operation not permitted" in r.stderr else "KERNEL_NAMESPACE_TEST_FAILED",
                "exitCode": r.returncode, "diagnostic": r.stderr[-350:],
                "gatePassed": False, "productionCutoverAuthorized": False}
    try:
        proof = json.loads(r.stdout)
    except ValueError:
        proof = {}
    passed = bool(proof.get("isolatedNamespace") and proof.get("readOnlyBindVerified") and
                  proof.get("productionRootTrusted") is False)
    return {"status": "ISOLATED_MOUNT_PROOF" if passed else "KERNEL_NAMESPACE_TEST_FAILED",
            "gatePassed": passed, "proof": proof, "productionCutoverAuthorized": False}


if __name__ == "__main__":
    result = test()
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["gatePassed"] else 2)
