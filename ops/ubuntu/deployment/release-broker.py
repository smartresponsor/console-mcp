#!/usr/bin/python3
"""Root-owned, explicitly provisioned UNIX-socket adapter to the existing Ubuntu release controller.

Do not execute this source checkout as root. Install the reviewed file into the
root-owned /opt/console-mcp-deploy/release-broker.py before enabling its unit.
"""
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import pwd
import re
import runpy
import socket
import signal
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
# Separate protocol: evidence only, never a deployment transaction.
PREMERGE_OPERATION = "premerge-accept"
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


class PolicySnapshot(dict):
    """Policy fields and digest from the same immutable file read."""

    def __init__(self, fields, digest):
        super().__init__(fields)
        self.generation = digest


def policy():
    protected(BASE)
    protected(POLICY)
    raw = POLICY.read_bytes()
    data = json.loads(raw)
    if data.get("schemaVersion") != 1:
        raise RuntimeError("RELEASE_BROKER_POLICY_INVALID")
    return PolicySnapshot(data, hashlib.sha256(raw).hexdigest())


def policy_identity(config):
    """Non-secret authorization evidence for the authenticated broker peer."""
    return {
        "brokerPid": os.getpid(),
        "policyPath": str(POLICY),
        "policyGeneration": getattr(config, "generation", None),
        "authorizedSha": config.get("authorizedSha"),
        "enabledOperations": config.get("enabledOperations", []),
    }


def authorization_lease_failure(config, now=None):
    """Legacy policies remain valid; a present lease must be valid and live."""
    lease = config.get("authorizationLease")
    if lease is None:
        return None
    if (not isinstance(lease, dict)
            or not isinstance(lease.get("owner"), str)
            or not lease["owner"]
            or type(lease.get("expiresAt")) not in (int, float)
            or not math.isfinite(lease["expiresAt"])):
        return "RELEASE_POLICY_LEASE_INVALID"
    if lease["expiresAt"] <= (time.time() if now is None else now):
        return "RELEASE_POLICY_LEASE_EXPIRED"
    return None


def authorization_denied(sha, config):
    return {
        "ok": False,
        "status": "RELEASE_SHA_NOT_AUTHORIZED",
        "requestedSha": sha,
        "authorization": policy_identity(config),
    }


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


def sealed_candidate(sha):
    """Return an existing candidate only after complete sealed provenance verification."""
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
    required = {'sourceCommit', 'buildFingerprint', 'files', 'lockfileSha256'}
    if not isinstance(verified, dict) or set(verified) != required:
        raise RuntimeError('RELEASE_CANDIDATE_MANIFEST_INVALID')
    files = verified.get('files')
    if (verified.get('sourceCommit') != sha
            or not isinstance(verified.get('buildFingerprint'), str)
            or re.fullmatch(r'[0-9a-f]{16}', verified['buildFingerprint']) is None
            or not isinstance(verified.get('lockfileSha256'), str)
            or re.fullmatch(r'[0-9a-f]{64}', verified['lockfileSha256']) is None
            or not isinstance(files, dict) or not files
            or files.get('package-lock.json') != verified['lockfileSha256']):
        raise RuntimeError('RELEASE_CANDIDATE_PROVENANCE_INVALID')
    controller_root = 'ops/ubuntu/deployment/'
    for name in ('prepare.py', 'deploy.py', 'gates.py', 'release-store-selector.py'):
        digest = files.get(controller_root + name)
        if not isinstance(digest, str) or re.fullmatch(r'[0-9a-f]{64}', digest) is None:
            raise RuntimeError('RELEASE_CANDIDATE_PROVENANCE_INVALID')
    return candidate


def sealed_candidate_exists(sha):
    """Check only the protected exact-SHA path; verification is mandatory before reuse."""
    if not isinstance(sha, str) or SHA.fullmatch(sha) is None:
        raise RuntimeError('RELEASE_FULL_SHA_REQUIRED')
    selector = BASE / 'release-store-selector.py'
    protected(BASE)
    protected(selector)
    store = runpy.run_path(str(selector), run_name='broker_store_selector')['store'](BASE)
    protected(store)
    candidate = store / sha
    if candidate.is_symlink():
        raise RuntimeError('RELEASE_CANDIDATE_OUTSIDE_PROTECTED_STORE')
    return candidate.exists()


def sealed_candidate_prepare(sha):
    """Run preparation only from the fully verified protected sealed candidate.

    Installed prepare.py intentionally rejects preparing from BASE. The existing
    installed deploy verifier must authenticate all candidate bytes before any
    candidate controller code is executed as root.
    """
    candidate = sealed_candidate(sha)
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
            ["/usr/bin/systemctl", "show", "console-mcp.service", "-p", "MainPID", "-p", "ActiveState",
             "-p", "BindReadOnlyPaths"],
            capture_output=True, text=True, timeout=10, check=False
        )
        unit = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    except (OSError, subprocess.TimeoutExpired):
        unit = {}
    loaded = None
    for binding in unit.get("BindReadOnlyPaths", "").split():
        parts = binding.split(":")
        if len(parts) >= 2 and parts[1] == "/home/alex/smartresponse/mcp/console-mcp/dist":
            identity = Path(parts[0]).parent.name
            if SHA.fullmatch(identity):
                loaded = identity
    return {"ok": True, "status": "RELEASE_BROKER_AVAILABLE", "registry": selected, "transactionPhase": phase,
            "runtime": {"pid": unit.get("MainPID"), "activeState": unit.get("ActiveState"),
                        "loadedRelease": loaded}}


def premerge_process_identity(pid):
    if not re.fullmatch(r'[1-9][0-9]*',str(pid)):raise RuntimeError('RELEASE_PREMERGE_PID_UNKNOWN')
    boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    text=(Path('/proc')/str(pid)/'stat').read_text();end=text.rfind(')')
    if end<0 or text.split(' ',1)[0]!=str(pid) or not re.fullmatch(r'[0-9a-f-]{36}',boot):raise RuntimeError('RELEASE_PREMERGE_PID_UNKNOWN')
    start=text[end+2:].split()[19]
    if not start.isdecimal():raise RuntimeError('RELEASE_PREMERGE_PID_UNKNOWN')
    return {'bootId':boot,'pid':str(pid),'startTicks':start}


def premerge_production_snapshot():
    state=registry_status()
    runtime=state.get('runtime') or {}
    if state.get('ok') is not True or runtime.get('activeState')!='active' or not re.fullmatch(r'[1-9][0-9]*',str(runtime.get('pid'))) or not SHA.fullmatch(str(runtime.get('loadedRelease'))):
        raise RuntimeError('RELEASE_PREMERGE_RUNTIME_IDENTITY_UNKNOWN')
    files={}
    for name in ('registry.json','transaction.json'):
        path=BASE/name
        if path.exists():
            protected(path);files[name]=hashlib.sha256(path.read_bytes()).hexdigest()
        else:files[name]=None
    if files['registry.json'] is None:raise RuntimeError('RELEASE_PREMERGE_REGISTRY_UNKNOWN')
    identity=premerge_process_identity(runtime['pid'])
    if registry_status()!=state or premerge_process_identity(runtime['pid'])!=identity:raise RuntimeError('RELEASE_PREMERGE_RUNTIME_RACE')
    return {'runtime':state,'protectedState':files,'processIdentity':identity}


def run_premerge_executable(operator,args,timeout=1200,lock_fd=None):
    protected(operator)
    command=['/usr/bin/python3','-I','-B',str(operator),*args]
    with subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True,pass_fds=() if lock_fd is None else (lock_fd,),env={'PATH':'/usr/bin:/bin','HOME':'/root'}) as proc:
        try:out,err=proc.communicate(timeout=timeout)
        except BaseException:
            try:os.killpg(proc.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            proc.communicate(timeout=10);raise
        return {'ok':proc.returncode==0,'exitCode':proc.returncode,'status':'RELEASE_CONTROLLER_COMPLETED' if proc.returncode==0 else 'RELEASE_CONTROLLER_FAILED','output':out[-8192:],'diagnostic':err[-2048:]}


def premerge_cleanup_helper(sha):
    path=BASE/'premerge-policy.json';helper=BASE/'premerge-provision.py'
    protected(BASE);protected(path);protected(helper)
    p=json.loads(path.read_bytes())
    if p.get('schemaVersion')!=3 or p.get('sha')!=sha or set(p.get('operators',{}))!={'premerge-provision.py','premerge-admission.py','premerge-bwrap-launcher.py'}:
        raise RuntimeError('RELEASE_PREMERGE_ADMIN_POLICY_REQUIRED')
    for name,pin in p['operators'].items():
        file=BASE/name;protected(file)
        if not re.fullmatch(r'[a-f0-9]{64}',str(pin)) or hashlib.sha256(file.read_bytes()).hexdigest()!=pin:raise RuntimeError('RELEASE_PREMERGE_OPERATOR_PIN')
    return runpy.run_path(str(helper),run_name='installed_premerge_cleanup')['cleanup_run']


def execute_operation(operation, sha, config, admission_run=None, lock_fd=None):
    if operation == PREMERGE_OPERATION:
        # Only an independently installed, root-owned operator can execute this path.
        # Never import or execute candidate controller code as root.
        current=policy()
        if getattr(current,'generation',None)!=getattr(config,'generation',None) or current.get('premergeAuthorization')!=config.get('premergeAuthorization'):
            return {'ok':False,'status':'RELEASE_PREMERGE_POLICY_CHANGED'}
        lease=current.get('premergeAuthorization')
        if not isinstance(lease,dict) or lease.get('sha')!=sha or authorization_lease_failure({'authorizationLease':lease}):
            return {'ok':False,'status':'RELEASE_PREMERGE_AUTHORIZATION_EXPIRED'}
        operator=BASE/'premerge-admission.py'
        protected(BASE);protected(operator)
        cleanup=premerge_cleanup_helper(sha)
        admission_run=admission_run or 'm7-'+uuid.uuid4().hex[:8]
        if not re.fullmatch(r'm7-[0-9a-f]{8}',admission_run) or os.path.lexists(BASE/'premerge-evidence'/admission_run):raise RuntimeError('RELEASE_PREMERGE_RUN_COLLISION')
        before=premerge_production_snapshot();after=None;failures=[];cleaned=[]
        try:
            result=run_premerge_executable(operator,['--sha',sha,'--run-id',admission_run],timeout=1200,lock_fd=lock_fd)
        except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as error:
            result={'ok':False,'status':'RELEASE_PREMERGE_CONTROLLER_EXCEPTION','errorType':type(error).__name__}
        finally:
            try:cleaned=cleanup(admission_run)
            except BaseException as error:failures.append('cleanup:'+type(error).__name__)
            try:after=premerge_production_snapshot()
            except BaseException as error:failures.append('continuity:'+type(error).__name__)
        if before!=after or failures:return {'ok':False,'status':'RELEASE_PREMERGE_PRODUCTION_DRIFT' if before!=after else 'RELEASE_PREMERGE_CLEANUP_FAILED','admissionRunId':admission_run,'failures':failures,'productionChanged':None if after is None else before!=after}
        result['admissionRunId']=admission_run;result['cleanedUnits']=cleaned;result['productionChanged']=False
        current=policy()
        if getattr(current,'generation',None)!=getattr(config,'generation',None) or current.get('premergeAuthorization')!=lease or authorization_lease_failure({'authorizationLease':lease}):
            return {'ok':False,'status':'RELEASE_PREMERGE_POLICY_CHANGED'}
        if result.get('ok'):
            try:receipt=json.loads(result['output'])
            except (KeyError,TypeError,ValueError):return {'ok':False,'status':'RELEASE_PREMERGE_RECEIPT_INVALID'}
            if type(receipt) is not dict or receipt.get('status')!='RELEASE_PREMERGE_ACCEPTANCE_PASS' or receipt.get('sourceSHA')!=sha or receipt.get('activationEligible') is not False or receipt.get('productionChanged') is not False or receipt.get('proof',{}).get('expectedBaselineVerified') is not True or not re.fullmatch(r'[a-f0-9]{64}',str(receipt.get('cleanupSha256'))):
                return {'ok':False,'status':'RELEASE_PREMERGE_RECEIPT_INVALID'}
        return result
    if operation == "prepare":
        source = config.get("sourcePath")
        if not isinstance(source, str) or not source.startswith("/home/alex/smartresponse/mcp/.worktrees/"):
            return {"ok": False, "status": "RELEASE_SOURCE_NOT_CONFIGURED"}
        if not sealed_candidate_exists(sha):
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
                and current.get("runtime", {}).get("loadedRelease") == sha
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
    binding = {
        "candidate": registry["candidate"],
        "sourceSHA": registry["sourceSHA"],
        "deploymentGeneration": checkpoint,
        "rollbackCheckpoint": checkpoint,
        "rollbackIdentity": rollback,
        "oldPid": registry["oldPid"],
        "rollbackRegistryFingerprint": registry["rollbackRegistryFingerprint"],
    }
    if 'browsingPair' in registry:
        pair=registry['browsingPair']
        fields={'status','consoleSHA','browsingSHA','consoleManifestSha256','browsingManifestSha256','leaseModuleSha256','workerSha256','activationEligible','policySha256'}
        if (type(pair) is not dict or set(pair)!=fields or pair['status']!='BROWSING_PAIR_INVENTORY_PASS'
                or pair['consoleSHA']!=sha or pair['activationEligible'] is not False
                or not isinstance(pair['browsingSHA'],str) or SHA.fullmatch(pair['browsingSHA']) is None
                or any(not isinstance(pair[n],str) or re.fullmatch('[0-9a-f]{64}',pair[n]) is None for n in fields if n.endswith('Sha256'))):
            raise RuntimeError('RELEASE_PAIR_BINDING_INVALID')
        binding['browsingPair']=pair
        plan=registry.get('browsingRuntimePlan')
        if (type(plan) is not dict or set(plan)!={'schemaVersion','pair','baseline','files','activationEligible'}
                or type(plan['schemaVersion']) is not int or plan['schemaVersion']!=1 or plan['pair']!=pair
                or plan['activationEligible'] is not False or type(plan['files']) is not dict or len(plan['files'])!=6
                or any(not isinstance(k,str) or not k.startswith('/') or not isinstance(v,str) or re.fullmatch('[0-9a-f]{64}',v) is None for k,v in plan['files'].items())
                or plan['baseline']!={'consolePid':registry['oldPid'],'workerState':'inactive','watchdogState':'inactive','leaseRootExisted':False}):
            raise RuntimeError('RELEASE_PAIR_RUNTIME_PLAN_INVALID')
        binding['browsingRuntimePlan']=plan
    elif 'browsingRuntimePlan' in registry:
        raise RuntimeError('RELEASE_PAIR_RUNTIME_PLAN_WITHOUT_PAIR')
    return binding


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
    lease_failure = authorization_lease_failure(config)
    if lease_failure:
        return {"ok": False, "status": lease_failure, "authorization": policy_identity(config)}
    if sha != config.get("authorizedSha"):
        return authorization_denied(sha, config)
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
            admission_run='m7-'+run_id[:8] if operation==PREMERGE_OPERATION else None
            record(run_id, {"runId": run_id, "operation": operation, "sha": sha,
                            "state": "running", "startedAt": time.time(), **({'admissionRunId':admission_run} if admission_run else {})})
            try:
                result = execute_operation(operation, sha, config, admission_run, lock.fileno()) if admission_run else execute_operation(operation, sha, config)
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


def handle_premerge(request):
    if set(request) != {'version','operation','sha','confirmed'} or request['operation'] != PREMERGE_OPERATION:
        return {'ok':False,'status':'RELEASE_PREMERGE_REQUEST_INVALID'}
    sha=request['sha']
    if type(sha) is not str or not SHA.fullmatch(sha):
        return {'ok':False,'status':'RELEASE_FULL_SHA_REQUIRED'}
    if request['confirmed'] is not True:
        return {'ok':False,'status':'RELEASE_EXPLICIT_CONFIRMATION_REQUIRED'}
    config=policy()
    lease=config.get('premergeAuthorization')
    if type(lease) is not dict or set(lease)!={'sha','expiresAt','owner'} or lease.get('sha')!=sha:
        return {'ok':False,'status':'RELEASE_PREMERGE_SHA_NOT_AUTHORIZED'}
    failure=authorization_lease_failure({'authorizationLease':{'owner':lease['owner'],'expiresAt':lease['expiresAt']}})
    if failure:return {'ok':False,'status':failure}
    if not BUSY.acquire(blocking=False):return {'ok':False,'status':'RELEASE_OPERATION_BUSY'}
    run_id=uuid.uuid4().hex
    try:
        record(run_id,{'runId':run_id,'operation':PREMERGE_OPERATION,'sha':sha,'state':'accepted','acceptedAt':time.time()})
        threading.Thread(target=worker,args=(run_id,PREMERGE_OPERATION,sha,config),daemon=True).start()
    except BaseException:
        BUSY.release();raise
    return {'ok':True,'status':'RELEASE_PREMERGE_ACCEPTED','runId':run_id,'sha':sha}


def handle(request):
    if isinstance(request,dict) and type(request.get('version')) is int and request['version']==3:
        return handle_premerge(request)
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
        result = registry_status()
        result["authorization"] = policy_identity(policy())
        return result
    if operation in ("activate", "rollback"):
        return {"ok": False, "status": "RELEASE_TRANSACTION_ID_REQUIRED"}
    sha = request.get("sha")
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        return {"ok": False, "status": "RELEASE_FULL_SHA_REQUIRED"}
    config = policy()
    lease_failure = authorization_lease_failure(config)
    if lease_failure:
        return {"ok": False, "status": lease_failure, "authorization": policy_identity(config)}
    if sha != config.get("authorizedSha"):
        return authorization_denied(sha, config)
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
