#!/usr/bin/python3
"""Root-owned, explicitly provisioned UNIX-socket adapter to the existing Ubuntu release controller.

Do not execute this source checkout as root. Install the reviewed file into the
root-owned /opt/console-mcp-deploy/release-broker.py before enabling its unit.
"""
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import runpy
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid

BASE = Path("/opt/console-mcp-deploy")
POLICY = BASE / "broker-policy.json"
SOCKET = Path("/run/console-mcp-release/release-broker.sock")
LOCK = BASE / "broker.lock"
SHA = re.compile(r"^[0-9a-f]{40}$")
OPERATIONS = frozenset(("status", "prepare", "validate", "activate", "rollback"))
CONTROLLERS = {
    "seal": BASE / "release-preparer.py",
    "prepare": BASE / "prepare.py",
    "deploy": BASE / "deploy.py",
}
MAX_REQUEST = 4096
RUNS = BASE / "broker-runs"
TRANSACTIONS = BASE / "broker-transactions"
BUSY = threading.Lock()


def protected(path):
    stat = path.lstat()
    if path.is_symlink() or stat.st_uid != 0 or stat.st_mode & 0o022:
        raise RuntimeError("RELEASE_BROKER_UNTRUSTED_ADMIN_PATH")


def policy():
    protected(BASE)
    protected(POLICY)
    data = json.loads(POLICY.read_text())
    if data.get("schemaVersion") != 1:
        raise RuntimeError("RELEASE_BROKER_POLICY_INVALID")
    return data


def run_executable(executable, args, timeout=1200):
    protected(executable)
    result = subprocess.run(
        ["/usr/bin/python3", "-I", str(executable), *args],
        capture_output=True, text=True, timeout=timeout, check=False,
        env={"PATH": "/usr/bin:/bin", "HOME": "/root"},
    )
    return {
        "ok": result.returncode == 0,
        "exitCode": result.returncode,
        "status": "RELEASE_CONTROLLER_COMPLETED" if result.returncode == 0 else "RELEASE_CONTROLLER_FAILED",
        "output": result.stdout[-8192:],
        "diagnostic": result.stderr[-2048:],
    }


def run(controller, args, timeout=1200):
    return run_executable(CONTROLLERS[controller], args, timeout=timeout)


def sealed_candidate_prepare(sha):
    """Run preparation only from the fully verified protected sealed candidate.

    Installed prepare.py intentionally rejects preparing from BASE. The existing
    installed deploy verifier must authenticate all candidate bytes before any
    candidate controller code is executed as root.
    """
    if not isinstance(sha, str) or SHA.fullmatch(sha) is None:
        raise RuntimeError('RELEASE_FULL_SHA_REQUIRED')
    selector = BASE / 'release-store-selector.py'
    installed_verifier = BASE / 'deploy.py'
    protected(BASE)
    protected(selector)
    protected(installed_verifier)
    store = runpy.run_path(str(selector), run_name='broker_store_selector')['store'](BASE)
    protected(store)
    candidate = store / sha
    protected(candidate)
    if candidate.resolve(strict=True).parent != store.resolve(strict=True):
        raise RuntimeError('RELEASE_CANDIDATE_OUTSIDE_PROTECTED_STORE')
    verified = runpy.run_path(str(installed_verifier), run_name='broker_sealed_verifier')['verify'](candidate)
    if verified.get('sourceCommit') != sha:
        raise RuntimeError('RELEASE_CANDIDATE_SHA_MISMATCH')
    source = candidate / 'ops' / 'ubuntu' / 'deployment'
    for name in ('prepare.py', 'deploy.py', 'gates.py', 'release-store-selector.py'):
        protected(source / name)
    return run_executable(source / 'prepare.py', ['prepare', '--sha', sha])


def registry_status():
    try:
        protected(BASE / "registry.json")
        registry = json.loads((BASE / "registry.json").read_text())
        selected = {key: registry.get(key) for key in ("candidate", "rollback", "sourceSHA")}
    except (FileNotFoundError, ValueError, RuntimeError):
        selected = None
    try:
        journal = json.loads((BASE / "transaction.json").read_text())
        phase = journal.get("phase")
    except (FileNotFoundError, ValueError):
        phase = None
    try:
        result = subprocess.run(
            ["/usr/bin/systemctl", "show", "console-mcp.service", "-p", "MainPID", "-p", "ActiveState"],
            capture_output=True, text=True, timeout=10, check=False
        )
        unit = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    except (OSError, subprocess.TimeoutExpired):
        unit = {}
    return {"ok": True, "status": "RELEASE_BROKER_AVAILABLE", "registry": selected, "transactionPhase": phase,
            "runtime": {"pid": unit.get("MainPID"), "activeState": unit.get("ActiveState")}}


def execute_operation(operation, sha, config):
    if operation == "prepare":
        source = config.get("sourcePath")
        if not isinstance(source, str) or not source.startswith("/home/alex/smartresponse/mcp/.worktrees/"):
            return {"ok": False, "status": "RELEASE_SOURCE_NOT_CONFIGURED"}
        sealed = run("seal", ["--source", source, "--sha", sha, "--seal"])
        if not sealed["ok"]:
            return sealed
        # Preparation, not validation, creates the immutable deployment generation.
        # Bind the transaction only after the sealed candidate controller has
        # created registry.json and its protected rollback checkpoint.
        return sealed_candidate_prepare(sha)
    if operation == "validate":
        current = registry_status()
        registry = current.get("registry") or {}
        if (registry.get("candidate") == sha and registry.get("sourceSHA") == sha
                and current.get("transactionPhase") == "committed"
                and current.get("runtime", {}).get("activeState") == "active"):
            return {
                "ok": False,
                "status": "RELEASE_ALREADY_ACTIVE",
                "failedGate": "candidate_must_not_be_loaded_release",
                "subsystem": "release-broker",
                "observedEvidence": {"sourceSHA": sha, "runtimePid": current["runtime"].get("pid")},
                "safeRemedy": "Use read-only full attestation and post-switch health; prepare a different sealed SHA for candidate validation.",
                "humanRequired": False,
                "retryable": False,
            }
        # Validation must not prepare again: doing so replaces the checkpoint
        # already sealed into the transaction's deployment binding.
        return run("prepare", ["validate", "--sha", sha])
    if operation in ("activate", "rollback"):
        current = registry_status()["registry"]
        if not current or current.get("sourceSHA") != sha:
            return {"ok": False, "status": "RELEASE_REGISTRY_SHA_MISMATCH"}
        # Existing deploy controller retains its own protected lock and gates.
        return run("deploy", ["apply" if operation == "activate" else "rollback"])
    return {"ok": False, "status": "RELEASE_OPERATION_INVALID"}


def record(run_id, payload):
    RUNS.mkdir(mode=0o700, exist_ok=True)
    protected(RUNS)
    target = RUNS / (run_id + ".json")
    temporary = RUNS / (run_id + "." + uuid.uuid4().hex + ".tmp")
    content = (json.dumps(payload, separators=(",", ":")) + "\n").encode()
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, target)
        dir_fd = os.open(RUNS, os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_record(run_id):
    if not isinstance(run_id, str) or not re.fullmatch(r"[0-9a-f]{32}", run_id):
        return {"ok": False, "status": "RELEASE_RUN_ID_INVALID"}
    try:
        protected(RUNS)
        target = RUNS / (run_id + ".json")
        protected(target)
        data = json.loads(target.read_text())
        return {"ok": True, "status": "RELEASE_OPERATION_STATUS", "run": data}
    except (FileNotFoundError, ValueError, RuntimeError):
        return {"ok": False, "status": "RELEASE_RUN_NOT_FOUND"}


def write_transaction(transaction_id, payload):
    TRANSACTIONS.mkdir(mode=0o700, exist_ok=True)
    protected(TRANSACTIONS)
    target = TRANSACTIONS / (transaction_id + ".json")
    temporary = TRANSACTIONS / (transaction_id + "." + uuid.uuid4().hex + ".tmp")
    content = (json.dumps(payload, separators=(",", ":")) + "\n").encode()
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, target)
        dir_fd = os.open(TRANSACTIONS, os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_transaction(transaction_id):
    if not isinstance(transaction_id, str) or not re.fullmatch(r"[0-9a-f]{32}", transaction_id):
        return {"ok": False, "status": "RELEASE_TRANSACTION_ID_INVALID"}
    try:
        protected(TRANSACTIONS)
        target = TRANSACTIONS / (transaction_id + ".json")
        protected(target)
        transaction = json.loads(target.read_text())
        if transaction.get("schemaVersion") != 1 or transaction.get("transactionId") != transaction_id:
            raise RuntimeError("RELEASE_TRANSACTION_EVIDENCE_INVALID")
        return {"ok": True, "status": "RELEASE_TRANSACTION_STATUS", "transaction": transaction}
    except FileNotFoundError:
        return {"ok": False, "status": "RELEASE_TRANSACTION_NOT_FOUND"}
    except (ValueError, RuntimeError):
        return {"ok": False, "status": "RELEASE_TRANSACTION_EVIDENCE_INVALID"}


def deployment_binding(sha):
    registry_path = BASE / "registry.json"
    protected(registry_path)
    registry = json.loads(registry_path.read_text())
    checkpoint = registry.get("checkpoint")
    rollback = registry.get("rollback")
    if (registry.get("schemaVersion") != 2 or registry.get("candidate") != sha
            or registry.get("sourceSHA") != sha or not isinstance(checkpoint, str)
            or not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{32}", checkpoint)
            or not isinstance(rollback, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}", rollback)
            or not isinstance(registry.get("oldPid"), int) or registry["oldPid"] <= 0
            or not isinstance(registry.get("rollbackRegistryFingerprint"), str)
            or not registry["rollbackRegistryFingerprint"]):
        raise RuntimeError("RELEASE_DEPLOYMENT_GENERATION_INVALID")
    checkpoint_path = BASE / "checkpoints" / checkpoint
    protected(checkpoint_path)
    if not checkpoint_path.is_dir():
        raise RuntimeError("RELEASE_ROLLBACK_CHECKPOINT_MISSING")
    return {
        "candidate": registry["candidate"],
        "sourceSHA": registry["sourceSHA"],
        "deploymentGeneration": checkpoint,
        "rollbackCheckpoint": checkpoint,
        "rollbackIdentity": rollback,
        "oldPid": registry["oldPid"],
        "rollbackRegistryFingerprint": registry["rollbackRegistryFingerprint"],
    }


def transaction_generation_matches(transaction, sha):
    expected = transaction.get("deploymentBinding")
    if not isinstance(expected, dict):
        return False
    try:
        return deployment_binding(sha) == expected
    except (FileNotFoundError, ValueError, RuntimeError):
        return False


def transaction_worker(transaction_id, operation, sha, config):
    try:
        with LOCK.open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            snapshot = read_transaction(transaction_id)
            if not snapshot.get("ok"):
                return
            transaction = snapshot["transaction"]
            if operation != "prepare" and not transaction_generation_matches(transaction, sha):
                result = {"ok": False, "status": "RELEASE_TRANSACTION_SUPERSEDED"}
            else:
                try:
                    result = execute_operation(operation, sha, config)
                except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                    result = {"ok": False, "status": "RELEASE_CONTROLLER_EXCEPTION", "errorType": type(error).__name__}
                if result.get("ok") and operation == "prepare":
                    try:
                        transaction["deploymentBinding"] = deployment_binding(sha)
                    except (FileNotFoundError, ValueError, RuntimeError) as error:
                        result = {"ok": False, "status": "RELEASE_TRANSACTION_GENERATION_EVIDENCE_MISSING",
                                  "errorType": type(error).__name__}
                elif result.get("ok") and not transaction_generation_matches(transaction, sha):
                    result = {"ok": False, "status": "RELEASE_TRANSACTION_SUPERSEDED"}
            evidence = dict(transaction.get("evidence") or {})
            evidence[operation] = result
            success_states = {"prepare": "prepared", "validate": "validated", "activate": "activated", "rollback": "rolled_back"}
            transaction.update({
                "state": success_states[operation] if result.get("ok") else operation + "_failed",
                "operation": operation,
                "updatedAt": time.time(),
                "evidence": evidence,
            })
            write_transaction(transaction_id, transaction)
    except (OSError, RuntimeError, BlockingIOError):
        snapshot = read_transaction(transaction_id)
        if snapshot.get("ok"):
            transaction = snapshot["transaction"]
            transaction.update({"state": "review_required", "updatedAt": time.time()})
            write_transaction(transaction_id, transaction)
    finally:
        BUSY.release()


def handle_transaction(request):
    if set(request) - {"version", "operation", "sha", "transactionId", "confirmed"}:
        return {"ok": False, "status": "RELEASE_BROKER_REQUEST_INVALID"}
    operation = request.get("operation")
    if operation not in OPERATIONS:
        return {"ok": False, "status": "RELEASE_BROKER_REQUEST_INVALID"}
    if operation == "status":
        return read_transaction(request.get("transactionId"))
    if request.get("confirmed") is not True:
        return {"ok": False, "status": "RELEASE_EXPLICIT_CONFIRMATION_REQUIRED"}
    config = policy()
    if operation == "prepare":
        sha = request.get("sha")
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            return {"ok": False, "status": "RELEASE_FULL_SHA_REQUIRED"}
        transaction_id = uuid.uuid4().hex
        expected_state = None
    else:
        transaction_id = request.get("transactionId")
        snapshot = read_transaction(transaction_id)
        if not snapshot.get("ok"):
            return snapshot
        transaction = snapshot["transaction"]
        sha = transaction.get("sha")
        expected_state = {"validate": "prepared", "activate": "validated", "rollback": ("activated", "activate_failed")}[operation]
        if transaction.get("state") not in ((expected_state,) if isinstance(expected_state, str) else expected_state):
            return {"ok": False, "status": "RELEASE_TRANSACTION_PHASE_MISMATCH",
                    "transactionId": transaction_id, "observedState": transaction.get("state")}
        evidence = transaction.get("evidence")
        required = {"validate": "prepare", "activate": "validate", "rollback": "activate"}[operation]
        if not isinstance(evidence, dict) or not isinstance(evidence.get(required), dict):
            return {"ok": False, "status": "RELEASE_TRANSACTION_EVIDENCE_MISSING", "requiredEvidence": required}
        if operation != "rollback" and evidence[required].get("ok") is not True:
            return {"ok": False, "status": "RELEASE_TRANSACTION_EVIDENCE_INVALID", "requiredEvidence": required}
        if not transaction_generation_matches(transaction, sha):
            return {"ok": False, "status": "RELEASE_TRANSACTION_SUPERSEDED", "transactionId": transaction_id}
    if sha != config.get("authorizedSha"):
        return {"ok": False, "status": "RELEASE_SHA_NOT_AUTHORIZED"}
    if operation not in config.get("enabledOperations", []):
        return {"ok": False, "status": "RELEASE_OPERATION_NOT_ENABLED"}
    if not BUSY.acquire(blocking=False):
        return {"ok": False, "status": "RELEASE_OPERATION_BUSY"}
    try:
        if operation == "prepare":
            transaction = {"schemaVersion": 1, "transactionId": transaction_id, "sha": sha,
                           "state": "prepare_running", "operation": operation,
                           "createdAt": time.time(), "updatedAt": time.time(), "evidence": {}}
        else:
            transaction.update({"state": operation + "_running", "operation": operation, "updatedAt": time.time()})
        write_transaction(transaction_id, transaction)
        threading.Thread(target=transaction_worker, args=(transaction_id, operation, sha, config), daemon=True).start()
    except BaseException:
        BUSY.release()
        raise
    return {"ok": True, "status": "RELEASE_TRANSACTION_ACCEPTED", "transactionId": transaction_id,
            "operation": operation, "sha": sha}


def worker(run_id, operation, sha, config):
    try:
        with LOCK.open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            record(run_id, {"runId": run_id, "operation": operation, "sha": sha,
                            "state": "running", "startedAt": time.time()})
            try:
                result = execute_operation(operation, sha, config)
            except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                result = {"ok": False, "status": "RELEASE_CONTROLLER_EXCEPTION",
                          "errorType": type(error).__name__}
            record(run_id, {"runId": run_id, "operation": operation, "sha": sha,
                            "state": "succeeded" if result.get("ok") else "failed",
                            "finishedAt": time.time(), "result": result})
    except (OSError, RuntimeError, BlockingIOError) as error:
        try:
            record(run_id, {"runId": run_id, "operation": operation, "sha": sha,
                            "state": "failed", "result": {"ok": False,
                            "status": "RELEASE_BROKER_WORKER_FAILED",
                            "errorType": type(error).__name__}})
        except OSError:
            pass
    finally:
        BUSY.release()


def recover_interrupted():
    RUNS.mkdir(mode=0o700, exist_ok=True)
    protected(RUNS)
    for path in RUNS.glob("*.json"):
        protected(path)
        item = json.loads(path.read_text())
        if item.get("state") in ("accepted", "running"):
            item["state"] = "interrupted"
            item["result"] = {"ok": False, "status": "RELEASE_OPERATION_INTERRUPTED_REVIEW_REQUIRED"}
            record(path.stem, item)
    TRANSACTIONS.mkdir(mode=0o700, exist_ok=True)
    protected(TRANSACTIONS)
    for path in TRANSACTIONS.glob("*.json"):
        protected(path)
        item = json.loads(path.read_text())
        if str(item.get("state", "")).endswith("_running"):
            item["state"] = "review_required"
            item["updatedAt"] = time.time()
            write_transaction(path.stem, item)


def handle(request):
    if isinstance(request, dict) and request.get("version") == 2:
        return handle_transaction(request)
    if not isinstance(request, dict) or set(request) - {"version", "operation", "sha", "runId"}:
        return {"ok": False, "status": "RELEASE_BROKER_REQUEST_INVALID"}
    operation = request.get("operation")
    if request.get("version") != 1 or operation not in OPERATIONS:
        return {"ok": False, "status": "RELEASE_BROKER_REQUEST_INVALID"}
    if operation == "status":
        if request.get("runId") is not None:
            return read_record(request.get("runId"))
        return registry_status()
    if operation in ("activate", "rollback"):
        return {"ok": False, "status": "RELEASE_TRANSACTION_ID_REQUIRED"}
    sha = request.get("sha")
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        return {"ok": False, "status": "RELEASE_FULL_SHA_REQUIRED"}
    config = policy()
    if sha != config.get("authorizedSha"):
        return {"ok": False, "status": "RELEASE_SHA_NOT_AUTHORIZED"}
    if operation not in config.get("enabledOperations", []):
        return {"ok": False, "status": "RELEASE_OPERATION_NOT_ENABLED"}
    if not BUSY.acquire(blocking=False):
        return {"ok": False, "status": "RELEASE_OPERATION_BUSY"}
    run_id = uuid.uuid4().hex
    try:
        record(run_id, {"runId": run_id, "operation": operation, "sha": sha,
                        "state": "accepted", "acceptedAt": time.time()})
        threading.Thread(target=worker, args=(run_id, operation, sha, config),
                         daemon=True).start()
    except BaseException:
        BUSY.release()
        raise
    return {"ok": True, "status": "RELEASE_OPERATION_ACCEPTED", "runId": run_id,
            "operation": operation, "sha": sha}

def serve():
    if os.geteuid() != 0:
        raise SystemExit("RELEASE_BROKER_ROOT_REQUIRED")
    protected(Path(__file__))
    protected(SOCKET.parent)
    policy()
    recover_interrupted()
    service_uid = pwd.getpwnam("console-mcp").pw_uid
    service_gid = pwd.getpwnam("console-mcp").pw_gid
    if SOCKET.exists():
        raise RuntimeError("RELEASE_BROKER_SOCKET_ALREADY_EXISTS")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(SOCKET))
    os.chown(SOCKET, 0, service_gid)
    os.chmod(SOCKET, 0o660)
    server.listen(8)
    while True:
        connection, _ = server.accept()
        with connection:
            connection.settimeout(15)
            uid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
            try:
                if uid != service_uid:
                    response = {"ok": False, "status": "RELEASE_BROKER_PEER_DENIED"}
                else:
                    chunks = []
                    length = 0
                    while length <= MAX_REQUEST:
                        fragment = connection.recv(min(1024, MAX_REQUEST + 1 - length))
                        if not fragment:
                            break
                        chunks.append(fragment)
                        length += len(fragment)
                        if b"\n" in fragment:
                            break
                    data = b"".join(chunks)
                    if len(data) > MAX_REQUEST or data.count(b"\n") != 1 or not data.endswith(b"\n"):
                        response = {"ok": False, "status": "RELEASE_BROKER_REQUEST_INVALID"}
                    else:
                        response = handle(json.loads(data))
            except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, BlockingIOError) as error:
                response = {"ok": False, "status": "RELEASE_BROKER_OPERATION_FAILED", "errorType": type(error).__name__}
            connection.sendall((json.dumps(response, separators=(",", ":")) + "\n").encode())


if __name__ == "__main__":
    serve()
