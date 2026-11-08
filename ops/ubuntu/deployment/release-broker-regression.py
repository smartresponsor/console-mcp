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
assert mod.handle({"version": 1, "operation": "activate", "sha": sha})["status"] == "RELEASE_TRANSACTION_ID_REQUIRED"
assert mod.handle({"version": 2, "operation": "status"})["status"] == "RELEASE_TRANSACTION_ID_INVALID"
assert mod.handle({"version": 1, "operation": "prepare", "sha": sha, "other": 1})["status"] == "RELEASE_BROKER_REQUEST_INVALID"
with tempfile.TemporaryDirectory(prefix="cmcp-release-broker-") as temporary:
    root = pathlib.Path(temporary)
    mod.BASE = root
    mod.RUNS = root / "runs"
    mod.TRANSACTIONS = root / "transactions"
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

    mod.policy = lambda: {"schemaVersion": 1, "authorizedSha": sha,
                          "enabledOperations": ["prepare", "validate", "activate", "rollback"]}
    planned = {"generation": 1, "rollback": "original-release"}
    transaction_calls = []
    def set_deployment(candidate, generation, rollback):
        checkpoint = "20261108T050000Z-" + format(generation, "032x")
        (root / "checkpoints" / checkpoint).mkdir(parents=True, exist_ok=True)
        (root / "registry.json").write_text(__import__("json").dumps({
            "schemaVersion": 2, "candidate": candidate, "sourceSHA": candidate,
            "checkpoint": checkpoint, "rollback": rollback, "oldPid": 123,
            "rollbackRegistryFingerprint": "registry-" + rollback,
        }))
    def execute_transaction(operation, candidate, config):
        transaction_calls.append((operation, candidate))
        if operation == "prepare":
            # Model the real controller: sealing alone does not touch the registry;
            # sealed candidate preparation creates the deployment generation.
            set_deployment(candidate, planned["generation"], planned["rollback"])
        elif operation == "validate":
            # Validation must preserve the checkpoint sealed by prepare.
            before = mod.deployment_binding(candidate)
            assert mod.deployment_binding(candidate) == before
        return {"ok": True, "status": "FAKE_" + operation.upper()}
    def wait_for_state(transaction_id, expected):
        for _ in range(100):
            transaction = mod.read_transaction(transaction_id)
            if transaction["transaction"]["state"] == expected:
                return transaction
            time.sleep(0.01)
        raise AssertionError((transaction_id, expected, transaction))
    mod.execute_operation = execute_transaction
    assert mod.handle({"version": 2, "operation": "prepare", "sha": sha})["status"] == "RELEASE_EXPLICIT_CONFIRMATION_REQUIRED"
    prepared = mod.handle({"version": 2, "operation": "prepare", "sha": sha, "confirmed": True})
    assert prepared["status"] == "RELEASE_TRANSACTION_ACCEPTED", prepared
    transaction_id = prepared["transactionId"]
    transaction = wait_for_state(transaction_id, "prepared")
    assert transaction["transaction"]["evidence"]["prepare"]["ok"] is True, transaction
    assert transaction["transaction"]["deploymentBinding"]["rollbackIdentity"] == "original-release"
    assert mod.handle({"version": 2, "operation": "activate", "transactionId": transaction_id,
                       "confirmed": True})["status"] == "RELEASE_TRANSACTION_PHASE_MISMATCH"
    assert mod.handle({"version": 2, "operation": "validate", "transactionId": "f" * 32,
                       "confirmed": True})["status"] == "RELEASE_TRANSACTION_NOT_FOUND"
    validated = mod.handle({"version": 2, "operation": "validate", "transactionId": transaction_id,
                            "confirmed": True})
    assert validated["status"] == "RELEASE_TRANSACTION_ACCEPTED", validated
    transaction = wait_for_state(transaction_id, "validated")
    assert transaction["transaction"]["evidence"]["validate"]["ok"] is True, transaction
    assert mod.handle({"version": 2, "operation": "activate", "transactionId": transaction_id})["status"] == "RELEASE_EXPLICIT_CONFIRMATION_REQUIRED"

    # A newer preparation for the same SHA supersedes the old deployment generation.
    set_deployment(sha, 2, "newer-rollback")
    calls_before_stale_activation = len(transaction_calls)
    stale_activation = mod.handle({"version": 2, "operation": "activate", "transactionId": transaction_id,
                                   "confirmed": True})
    assert stale_activation["status"] == "RELEASE_TRANSACTION_SUPERSEDED", stale_activation
    assert len(transaction_calls) == calls_before_stale_activation, "stale activation reached the controller"

    # Prepare and activate T1, then simulate A -> B -> A with a different rollback checkpoint.
    planned.update({"generation": 3, "rollback": "original-release"})
    prepared = mod.handle({"version": 2, "operation": "prepare", "sha": sha, "confirmed": True})
    transaction_id = prepared["transactionId"]
    wait_for_state(transaction_id, "prepared")
    mod.handle({"version": 2, "operation": "validate", "transactionId": transaction_id, "confirmed": True})
    wait_for_state(transaction_id, "validated")
    activated = mod.handle({"version": 2, "operation": "activate", "transactionId": transaction_id,
                            "confirmed": True})
    assert activated["status"] == "RELEASE_TRANSACTION_ACCEPTED", activated
    wait_for_state(transaction_id, "activated")
    set_deployment("b" * 40, 4, sha)
    set_deployment(sha, 5, "b" * 40)
    calls_before_stale_rollback = len(transaction_calls)
    stale_rollback = mod.handle({"version": 2, "operation": "rollback", "transactionId": transaction_id,
                                 "confirmed": True})
    assert stale_rollback["status"] == "RELEASE_TRANSACTION_SUPERSEDED", stale_rollback
    assert len(transaction_calls) == calls_before_stale_rollback, "stale rollback reached the controller"

    # A current transaction remains able to activate and roll back its own exact checkpoint.
    planned.update({"generation": 6, "rollback": "b" * 40})
    prepared = mod.handle({"version": 2, "operation": "prepare", "sha": sha, "confirmed": True})
    transaction_id = prepared["transactionId"]
    wait_for_state(transaction_id, "prepared")
    mod.handle({"version": 2, "operation": "validate", "transactionId": transaction_id, "confirmed": True})
    wait_for_state(transaction_id, "validated")
    mod.handle({"version": 2, "operation": "activate", "transactionId": transaction_id, "confirmed": True})
    wait_for_state(transaction_id, "activated")
    rolled_back = mod.handle({"version": 2, "operation": "rollback", "transactionId": transaction_id,
                              "confirmed": True})
    assert rolled_back["status"] == "RELEASE_TRANSACTION_ACCEPTED", rolled_back
    transaction = wait_for_state(transaction_id, "rolled_back")
    assert transaction["transaction"]["evidence"]["rollback"]["ok"] is True, transaction
    assert mod.handle({"version": 2, "operation": "status", "transactionId": transaction_id})["transaction"]["state"] == "rolled_back"
    mod.write_transaction("c" * 32, {"schemaVersion": 1, "transactionId": "c" * 32, "sha": sha,
                                     "state": "validated", "evidence": {}})
    assert mod.handle({"version": 2, "operation": "activate", "transactionId": "c" * 32,
                       "confirmed": True})["status"] == "RELEASE_TRANSACTION_EVIDENCE_MISSING"
    mod.write_transaction("d" * 32, {"schemaVersion": 1, "transactionId": "d" * 32, "sha": sha,
                                     "state": "activate_running", "evidence": transaction["transaction"]["evidence"],
                                     "deploymentBinding": transaction["transaction"]["deploymentBinding"]})
    mod.recover_interrupted()
    assert mod.read_transaction("d" * 32)["transaction"]["state"] == "review_required"
    for operation in ("activate", "rollback"):
        interrupted = mod.handle({"version": 2, "operation": operation, "transactionId": "d" * 32,
                                  "confirmed": True})
        assert interrupted["status"] == "RELEASE_TRANSACTION_PHASE_MISMATCH", interrupted
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
assert calls == [('installed', 'prepare', ['validate', '--sha', sha])], calls
calls.clear()
mod.sealed_candidate_prepare = lambda sha: (calls.append(('prepared', sha)) or {'ok': True, 'status': 'PREPARED'})
mod.run = lambda controller, args, timeout=1200: (
    calls.append(('controller', controller, args)) or {'ok': True, 'status': 'SEALED'}
)
result = mod.execute_operation('prepare', sha, {'sourcePath': '/home/alex/smartresponse/mcp/.worktrees/test'})
assert result['status'] == 'PREPARED', result
assert calls == [
    ('controller', 'seal', ['--source', '/home/alex/smartresponse/mcp/.worktrees/test', '--sha', sha, '--seal']),
    ('prepared', sha),
], calls
calls.clear()
mod.run = lambda controller, args, timeout=1200: (
    calls.append(('controller', controller, args)) or {'ok': False, 'status': 'SEAL_FAILED'}
)
result = mod.execute_operation('prepare', sha, {'sourcePath': '/home/alex/smartresponse/mcp/.worktrees/test'})
assert result['status'] == 'SEAL_FAILED' and calls == [
    ('controller', 'seal', ['--source', '/home/alex/smartresponse/mcp/.worktrees/test', '--sha', sha, '--seal'])
], calls
calls.clear()
mod.run = lambda controller, args, timeout=1200: (
    calls.append(('controller', controller, args)) or {'ok': True, 'status': 'SEALED'}
)
mod.sealed_candidate_prepare = lambda sha: (calls.append(('prepared', sha)) or {'ok': False, 'status': 'PREPARATION_FAILED'})
result = mod.execute_operation('prepare', sha, {'sourcePath': '/home/alex/smartresponse/mcp/.worktrees/test'})
assert result['status'] == 'PREPARATION_FAILED' and calls == [
    ('controller', 'seal', ['--source', '/home/alex/smartresponse/mcp/.worktrees/test', '--sha', sha, '--seal']),
    ('prepared', sha),
], calls

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
