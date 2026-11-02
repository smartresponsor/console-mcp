#!/usr/bin/python3
"""Unprivileged broker fixture: no calls to systemd, sudo, or production controller."""
import importlib.util
import pathlib
import tempfile
import time

source = pathlib.Path(__file__).with_name("release-broker.py")
spec = importlib.util.spec_from_file_location("release_broker_under_test", source)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
sha = "a" * 40
assert mod.handle({"version": 1, "operation": "prepare", "sha": "x"})["status"] == "RELEASE_FULL_SHA_REQUIRED"
assert mod.handle({"version": 2, "operation": "status"})["status"] == "RELEASE_BROKER_REQUEST_INVALID"
assert mod.handle({"version": 1, "operation": "prepare", "sha": sha, "other": 1})["status"] == "RELEASE_BROKER_REQUEST_INVALID"
with tempfile.TemporaryDirectory(prefix="cmcp-release-broker-") as temporary:
    root = pathlib.Path(temporary)
    mod.BASE = root
    mod.RUNS = root / "runs"
    mod.LOCK = root / "lock"
    mod.protected = lambda path: None
    mod.policy = lambda: {"schemaVersion": 1, "authorizedSha": sha, "enabledOperations": []}
    assert mod.handle({"version": 1, "operation": "prepare", "sha": sha})["status"] == "RELEASE_OPERATION_NOT_ENABLED"
    mod.policy = lambda: {"schemaVersion": 1, "authorizedSha": sha, "enabledOperations": ["prepare"]}
    mod.execute_operation = lambda operation, sha, config: {"ok": True, "status": "FAKE_ONLY"}
    response = mod.handle({"version": 1, "operation": "prepare", "sha": sha})
    assert response["status"] == "RELEASE_OPERATION_ACCEPTED", response
    run_id = response["runId"]
    assert len(run_id) == 32
    for _ in range(100):
        snapshot = mod.read_record(run_id)
        if snapshot["run"]["state"] == "succeeded":
            break
        time.sleep(0.01)
    assert snapshot["run"]["result"]["status"] == "FAKE_ONLY", snapshot
    mod.record("b" * 32, {"runId": "b" * 32, "state": "running"})
    mod.recover_interrupted()
    assert mod.read_record("b" * 32)["run"]["state"] == "interrupted"
    assert mod.read_record("../x")["status"] == "RELEASE_RUN_ID_INVALID"
print("RELEASE_BROKER_ASYNC_FIXTURE_GREEN")
