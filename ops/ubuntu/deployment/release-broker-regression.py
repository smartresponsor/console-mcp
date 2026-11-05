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
original_execute_operation = mod.execute_operation
original_sealed_candidate_prepare = mod.sealed_candidate_prepare
original_registry_status = mod.registry_status
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
mod.execute_operation = original_execute_operation
calls = []
mod.registry_status = lambda: {"registry": {"candidate": sha, "sourceSHA": sha},
                               "transactionPhase": "committed",
                               "runtime": {"activeState": "active", "pid": "123"}}
result = mod.execute_operation('validate', sha, {'enabledOperations': ['validate']})
assert result['status'] == 'RELEASE_ALREADY_ACTIVE' and result['failedGate'] == 'candidate_must_not_be_loaded_release', result
assert result['humanRequired'] is False and result['retryable'] is False, result
mod.registry_status = lambda: {"registry": None, "transactionPhase": None, "runtime": {}}
mod.sealed_candidate_prepare = lambda sha: (calls.append(('sealed', sha)) or {'ok': True, 'status': 'SEALED_PREPARED'})
mod.run = lambda controller, args, timeout=1200: (calls.append(('installed', controller, args)) or {'ok': True, 'status': 'VALIDATED'})
result = mod.execute_operation('validate', sha, {'enabledOperations': ['validate']})
assert result['status'] == 'VALIDATED', result
assert calls == [('sealed', sha), ('installed', 'prepare', ['validate', '--sha', sha])], calls
calls.clear()
mod.sealed_candidate_prepare = lambda sha: (calls.append(('sealed', sha)) or {'ok': False, 'status': 'SEALED_REJECTED'})
result = mod.execute_operation('validate', sha, {'enabledOperations': ['validate']})
assert result['status'] == 'SEALED_REJECTED' and calls == [('sealed', sha)], calls

# A sealed candidate is only executable after the pinned installed verifier
# attests its complete release manifest, source SHA and protected paths.
mod.sealed_candidate_prepare = original_sealed_candidate_prepare
mod.registry_status = original_registry_status
with tempfile.TemporaryDirectory(prefix="broker-seal-source-fixture-") as temp:
    root = pathlib.Path(temp)
    store = root / "sealed"
    candidate = store / sha
    source_path = candidate / "ops/ubuntu/deployment"
    source_path.mkdir(parents=True)
    mod.BASE = root
    mod.protected = lambda path: None
    original_runpy_path = mod.runpy.run_path
    original_run_executable = mod.run_executable
    seen = []
    def fake_run_path(path, run_name=None):
        if path == str(root / "release-store-selector.py"):
            return {"store": lambda _: store}
        if path == str(root / "deploy.py"):
            return {"verify": lambda selected: seen.append(("verified", selected)) or {"sourceCommit": sha}}
        raise AssertionError("Unexpected executable: " + path)
    mod.runpy.run_path = fake_run_path
    mod.run_executable = lambda executable, args, timeout=1200: (
        seen.append(("executed", executable, args)) or {"ok": True, "status": "SEALED_EXECUTED"}
    )
    assert mod.sealed_candidate_prepare(sha)["status"] == "SEALED_EXECUTED"
    assert seen == [
        ("verified", candidate),
        ("executed", source_path / "prepare.py", ["prepare", "--sha", sha]),
    ], seen
    seen.clear()
    mod.runpy.run_path = lambda path, run_name=None: (
        {"store": lambda _: store} if path == str(root / "release-store-selector.py")
        else {"verify": lambda selected: {"sourceCommit": "f" * 40}}
    )
    try:
        mod.sealed_candidate_prepare(sha)
        raise AssertionError("Must reject misattributed sealed candidate")
    except RuntimeError as error:
        assert str(error) == "RELEASE_CANDIDATE_SHA_MISMATCH"
    assert not seen, "SHA mismatch must never execute a candidate controller"
    mod.runpy.run_path = original_runpy_path
    mod.run_executable = original_run_executable

print("RELEASE_BROKER_ASYNC_AND_SEALED_PREPARE_FIXTURE_GREEN")
