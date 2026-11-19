#!/usr/bin/python3
"""Real cross-process durable-fence tests: handshake, loss, crash, exclusive refusal."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

HELPER = Path(__file__).resolve().parents[1] / "ops/ubuntu/deployment/admission-lock.py"
spec = importlib.util.spec_from_file_location("admission_fixture", HELPER)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
CHILD = """
import importlib.util,os,sys
from pathlib import Path
sp=importlib.util.spec_from_file_location('ad',sys.argv[1])
mod=importlib.util.module_from_spec(sp)
sp.loader.exec_module(mod)
mod.hold_session('shared',max_seconds=15,directory=Path(sys.argv[2]),
                 lock_path=Path(sys.argv[3]),expected_uid=os.getuid())
"""

def spawn_session(directory, lock):
    proc = subprocess.Popen([sys.executable, "-I", "-c", CHILD, str(HELPER),
                             str(directory), str(lock)], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    hello = json.loads(proc.stdout.readline())
    assert hello["ok"] is True and hello["status"] == "ADMISSION_LOCKED"
    assert len(hello["nonce"]) == 48
    return proc, hello["nonce"]

def assert_blocked(directory):
    try:
        m.assert_inflight_empty(directory,expected_uid=os.getuid())
        raise AssertionError("orphan fence missed")
    except m.AdmissionError as exc:
        assert str(exc) == "ADMISSION_INFLIGHT_NOT_EMPTY"

with tempfile.TemporaryDirectory(prefix="stage11-inflight-") as temp:
    base = Path(temp)
    base.chmod(0o700)
    lock=base/"admission.lock"
    lock.write_text("owned")
    lock.chmod(0o640)
    directory=base/"inflight"
    directory.mkdir(mode=0o700)
    uid=os.getuid()

    # Two shared sessions can publish simultaneously. Exclusive stays blocked.
    a, an = spawn_session(directory,lock)
    b, bn = spawn_session(directory,lock)
    assert len(list(directory.iterdir())) == 2
    try:
        with m.admission("exclusive",lock,timeout=0.12,expected_uid=uid):
            raise AssertionError("exclusive entered with shared sessions alive")
        raise AssertionError("exclusive must refuse")
    except m.AdmissionError as exc:
        assert str(exc)=="ADMISSION_BUSY"
    assert_blocked(directory)

    # Explicit nonce-bound release is the sole way to clear each marker.
    a.stdin.write("RELEASE "+an+"\n")
    a.stdin.flush()
    ack=json.loads(a.stdout.readline())
    assert ack == {"ok":True,"status":"ADMISSION_RELEASED","nonce":an}
    a.wait(timeout=3)
    assert a.returncode==0
    assert len(list(directory.iterdir()))==1
    assert_blocked(directory)

    # SIGKILL of the remaining helper releases flock, but NOT the marker.
    b.kill()
    b.wait(timeout=3)
    assert len(list(directory.iterdir()))==1
    with m.admission("exclusive",lock,timeout=.2,expected_uid=uid):
        assert_blocked(directory)
    assert (directory/(bn+".json")).exists()
    print("STAGE11_KILLED_HELPER_FENCE_PERSISTS_PASS")

    # Independent clean fixture: EOF without a release message fails closed.
    (directory/(bn+".json")).unlink()  # test-owned fixture cleanup only
    c, cn = spawn_session(directory,lock)
    c.stdin.close()
    c.wait(timeout=3)
    assert c.returncode != 0
    assert_blocked(directory)
    assert (directory/(cn+".json")).exists()
    (directory/(cn+".json")).unlink()

    # Unknown nonce cannot clear a marker.
    d, dn = spawn_session(directory,lock)
    d.stdin.write("RELEASE "+("f"*48)+"\n")
    d.stdin.flush()
    d.wait(timeout=3)
    assert d.returncode != 0
    assert_blocked(directory)
    assert (directory/(dn+".json")).exists()
    (directory/(dn+".json")).unlink()
    m.assert_inflight_empty(directory,expected_uid=uid)

    # Unexpected marker content must also block.
    (directory/"malformed").write_text("not-json")
    assert_blocked(directory)
    (directory/"malformed").unlink()
    # Parent/directory ACL and namespace replacement boundaries.
    directory.chmod(0o770)
    try:
        m.assert_inflight_empty(directory,expected_uid=uid)
        raise AssertionError("group-writable directory accepted")
    except m.AdmissionError as exc:
        assert str(exc)=="ADMISSION_INFLIGHT_DIRECTORY_UNTRUSTED"
    directory.chmod(0o700)
    base.chmod(0o770)
    try:
        m.assert_inflight_empty(directory,expected_uid=uid)
        raise AssertionError("group-writable parent accepted")
    except m.AdmissionError as exc:
        assert str(exc)=="ADMISSION_INFLIGHT_PARENT_UNTRUSTED"
    base.chmod(0o700)
    directory.rmdir()
    directory.symlink_to(base/"absent-dir")
    try:
        m.assert_inflight_empty(directory,expected_uid=uid)
        raise AssertionError("symlinked directory accepted")
    except (OSError,m.AdmissionError):
        pass
    directory.unlink()
    print("STAGE11_DURABLE_INFLIGHT_FENCE_ADVERSARIAL_PASS")
