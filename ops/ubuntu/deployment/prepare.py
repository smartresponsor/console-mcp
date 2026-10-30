#!/usr/bin/python3
"""Root-owned preparation and isolated proof; never restart the production unit."""
import sys
if not sys.flags.isolated:
    raise SystemExit('Use /usr/bin/python3 -I')
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import shutil
import subprocess
import time
import uuid

B = Path('/opt/console-mcp-deploy')
L = Path('/home/alex/smartresponse/mcp/console-mcp')
SYSTEM = Path('/etc/systemd/system')
OPERATORS = ('deploy.py', 'gates.py', 'permissions-check.py', 'lease-check.mjs', 'diagnostic-test.ps1', 'prepare.py')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def protected(path):
    st = path.lstat()
    if path.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
        raise RuntimeError('Untrusted administrative path: ' + str(path))


def load(path):
    return json.loads(path.read_text())


def check_pending():
    state = B / 'transaction.json'
    if state.exists() and load(state)['phase'] not in ('committed', 'rolled_back'):
        raise RuntimeError('Recover the pending production transaction before preparation')


def current_release(gates):
    # Read the actual loaded mount namespace contract, never the historical registry.
    bindings = gates['show']('console-mcp.service', 'BindReadOnlyPaths').split()
    sources = [entry.split(':')[0] for entry in bindings
               if len(entry.split(':')) >= 2 and entry.split(':')[1] == str(L / 'dist')]
    if len(sources) != 1:
        raise RuntimeError('Active release binding is ambiguous')
    tree = Path(sources[0]).parent
    if tree.is_symlink() or tree.resolve().parent != (B / 'releases').resolve():
        raise RuntimeError('Active runtime is not a protected versioned release')
    return tree


def checkpoint(generation, pid):
    dest = B / 'checkpoints' / generation
    dest.mkdir(parents=True, mode=0o700)
    shutil.copyfile(SYSTEM / 'console-mcp.service', dest / 'console-mcp.service')
    shutil.copytree(SYSTEM / 'console-mcp.service.d', dest / 'dropins')
    shutil.copyfile('/etc/console-mcp/console-mcp.env', dest / 'environment')
    (dest / 'process-environment').write_bytes(Path(f'/proc/{pid}/environ').read_bytes())
    originals = dest / 'deployment-controller'
    originals.mkdir(mode=0o700)
    for name in (*OPERATORS, 'registry.json', 'transaction.json', 'browser-baseline.json', 'browser-processes.json', 'target-id', 'sandbox-result.json', 'rollback-sandbox-result.json'):
        if (B / name).is_file():
            shutil.copyfile(B / name, originals / name)
    sandbox = dest / 'sandbox-units'
    sandbox.mkdir(mode=0o700)
    for role in ('candidate', 'rollback'):
        unit = Path('/run/systemd/system/console-mcp-' + role + '-check.service')
        if unit.is_file():
            shutil.copyfile(unit, sandbox / unit.name)
        dropins = unit.with_name(unit.name + '.d')
        if dropins.is_dir():
            shutil.copytree(dropins, sandbox / dropins.name)
    for path in dest.rglob('*'):
        path.chmod(0o700 if path.is_dir() else 0o600)
    return dest


def configure_check(role, tree, port, deploy, reg):
    unit = 'console-mcp-' + role + '-check.service'
    deploy['ctl']('stop', unit)
    path = Path('/run/systemd/system') / unit
    dropins = path.with_name(unit + '.d')
    dropins.mkdir(exist_ok=True)
    allowed = {'90-validation.conf'} | {p.name for p in (SYSTEM / 'console-mcp.service.d').glob('*.conf') if p.name != '90-versioned-runtime.conf'}
    if any(p.name not in allowed for p in dropins.iterdir()):
        raise RuntimeError('Unexpected sandbox drop-in preserved; review before preparation')
    deploy['atomic'](path, (SYSTEM / 'console-mcp.service').read_bytes(), 0o644)
    for source in (SYSTEM / 'console-mcp.service.d').glob('*.conf'):
        if source.name != '90-versioned-runtime.conf':
            deploy['atomic'](dropins / source.name, source.read_bytes(), 0o644)
    scratch = Path('/var/lib/console-mcp/deployment-check') / reg['checkpoint'] / role
    import pwd
    owner = pwd.getpwnam('console-mcp')
    for directory in (scratch.parent, scratch):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chown(directory, owner.pw_uid, owner.pw_gid)
    for name in ('run', 'log', 'transcript', 'workspace'):
        directory = scratch / name
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chown(directory, owner.pw_uid, owner.pw_gid)
    env_path = B / (role + '-probe.env')
    values = {
        'CONSOLE_MCP_BEARER_TOKEN': secrets.token_urlsafe(48),
        'CONSOLE_MCP_AUTH_MODE': 'bearer', 'CONSOLE_MCP_HOST': '127.0.0.1',
        'CONSOLE_MCP_PORT': str(port), 'CONSOLE_MCP_MANAGED_RUNTIME': 'smoke-test',
        'CONSOLE_MCP_RELEASE_PROBE': '1', 'CONSOLE_MCP_INTERACTIVE_UID': '1000',
        'CONSOLE_MCP_DEPLOY_ROLE': role,
        'CONSOLE_MCP_WORKSPACE_ROOT': str(scratch / 'workspace'),
    }
    deploy['atomic'](env_path, ''.join(k + '=' + v + '\n' for k, v in values.items()).encode())
    lines = ['[Service]', 'BindPaths=', 'BindReadOnlyPaths=', 'ExecStartPost=', 'Restart=no',
             'EnvironmentFile=' + str(env_path)]
    lines.extend('BindReadOnlyPaths=' + str(tree / n) + ':' + str(L / n)
                 for n in deploy['PARTS'] if (tree / n).exists())
    lines.extend('BindPaths=' + str(scratch / n) + ':' + str(L / 'var' / n)
                 for n in ('run', 'log', 'transcript'))
    lines += ['ExecStartPost=/usr/bin/python3 -I ' + str(B / 'permissions-check.py'),
              'ExecStartPost=/usr/bin/pwsh -NoProfile -File ' + str(B / 'diagnostic-test.ps1'),
              'ExecStartPost=/usr/bin/node ' + str(B / 'lease-check.mjs')]
    deploy['atomic'](dropins / '90-validation.conf', ('\n'.join(lines) + '\n').encode(), 0o644)


def prepare(sha, source, deploy, gates):
    check_pending()
    candidate = B / 'releases' / sha
    manifest = deploy['verify'](candidate)
    if manifest.get('sourceCommit') != sha or source != candidate / 'ops/ubuntu/deployment':
        raise RuntimeError('Run the preparation controller from the exact sealed candidate')
    old = current_release(gates)
    if old == candidate:
        raise RuntimeError('Candidate is already the loaded release')
    old_manifest = deploy['verify'](old)
    pid = int(gates['show']('console-mcp.service', 'MainPID'))
    health = gates['rpc'](pid, 3334, 'read_.system.console.health')
    if not health.get('ok') or health.get('pid') != pid or health.get('buildFingerprint') != old_manifest['buildFingerprint']:
        raise RuntimeError('Actual production health does not match the sealed rollback')
    gates['queue']()
    browser = gates['browser']()
    processes = gates['browser_processes']()
    target = (B / 'target-id').read_text().strip()
    if not any(t[0] == target and t[1] == 'page' for t in browser['cdp']['9224']['targets']):
        raise RuntimeError('Preserved visible target is no longer present')
    if not gates['agent']('verify', targetId=target).get('ok'):
        raise RuntimeError('Current visible target lacks native proof')
    generation = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex
    checkpoint(generation, pid)
    reg = dict(schemaVersion=2, candidate=sha, sourceSHA=sha, rollback=old.name, oldPid=pid,
               checkpoint=generation, preparedAt=time.time(), probePort=53446, rollbackProbePort=53447,
               targetPort=9224, expectedWindowCount=len(browser['windows']),
               expectedPageCount=sum(t[1] == 'page' for c in browser['cdp'].values() for t in c['targets']),
               rollbackRegistryFingerprint=health['canonicalRegistryFingerprint'],
               operatorHashes={name: digest(source / name) for name in OPERATORS})
    for name in OPERATORS:
        deploy['atomic'](B / name, (source / name).read_bytes(), 0o644)
    deploy['atomic'](B / 'browser-baseline.json', json.dumps(browser).encode(), 0o644)
    deploy['atomic'](B / 'browser-processes.json', json.dumps(processes).encode(), 0o644)
    deploy['atomic'](B / 'registry.json', json.dumps(reg, indent=2).encode(), 0o644)
    configure_check('rollback', old, reg['rollbackProbePort'], deploy, reg)
    configure_check('candidate', candidate, reg['probePort'], deploy, reg)
    deploy['ctl']('daemon-reload')
    if int(gates['show']('console-mcp.service', 'MainPID')) != pid:
        raise RuntimeError('Production PID changed during preparation')
    print(json.dumps(dict(prepared=True, sourceSHA=sha, rollback=old.name, checkpoint=generation, productionRestarted=False)))


def validate(sha, deploy, gates):
    check_pending()
    reg = load(B / 'registry.json')
    if reg['sourceSHA'] != sha or reg['candidate'] != sha:
        raise RuntimeError('Prepared source identity mismatch')
    for name, expected in reg['operatorHashes'].items():
        protected(B / name)
        if digest(B / name) != expected:
            raise RuntimeError('Administrative controller drift')
    gates['queue']()
    gates['verify_browser_snapshot'](reg)
    for role, port in (('rollback', reg['rollbackProbePort']), ('candidate', reg['probePort'])):
        tree = deploy['release'](reg, role)
        manifest = deploy['verify'](tree)
        unit = 'console-mcp-' + role + '-check.service'
        try:
            deploy['ctl']('restart', unit)
            if gates['show'](unit, 'ActiveState') != 'active':
                raise RuntimeError('Isolated check unit is not active')
            pid = int(gates['show'](unit, 'MainPID'))
            health = gates['rpc'](pid, port, 'read_.system.console.health')
            if not health.get('ok') or health.get('pid') != pid or health.get('buildFingerprint') != manifest['buildFingerprint']:
                raise RuntimeError('Isolated authenticated build verification failed')
            if role == 'rollback' and health['canonicalRegistryFingerprint'] != reg['rollbackRegistryFingerprint']:
                raise RuntimeError('Rollback registry differs from current production')
            gates['verify_browser_snapshot'](reg)
            proof = dict(passed=True, at=time.time(), registryFingerprint=health['canonicalRegistryFingerprint'],
                         buildFingerprint=health['buildFingerprint'], pid=pid, sourceSHA=sha, **{role:reg[role]})
            deploy['atomic'](B / ('sandbox-result.json' if role == 'candidate' else 'rollback-sandbox-result.json'), json.dumps(proof, indent=2).encode())
        finally:
            deploy['ctl']('stop', unit)
    if int(gates['show']('console-mcp.service', 'MainPID')) != reg['oldPid']:
        raise RuntimeError('Production PID changed during isolated validation')
    print(json.dumps(dict(validated=True, sourceSHA=sha, productionRestarted=False)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'validate'))
    parser.add_argument('--sha', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or not re.fullmatch('[0-9a-f]{40}', args.sha):
        raise RuntimeError('Root and exact master SHA required')
    for path in (B, B / 'releases', B / 'deploy.py', B / 'gates.py'):
        protected(path)
    source = Path(__file__).resolve().parent
    # Only installed protected code or the fully verified sealed candidate may run.
    if source not in (B, B / 'releases' / args.sha / 'ops/ubuntu/deployment'):
        raise RuntimeError('Unsealed preparation controller')
    deploy = runpy.run_path(str(B / 'deploy.py'), run_name='controller_library')
    if source != B:
        manifest = deploy['verify'](B / 'releases' / args.sha)
        if manifest.get('sourceCommit') != args.sha:
            raise RuntimeError('Candidate source attestation mismatch')
    gates = runpy.run_path(str(source / 'gates.py'), run_name='gate_library')
    with (B / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'prepare':
            prepare(args.sha, source, deploy, gates)
        else:
            validate(args.sha, deploy, gates)


if __name__ == '__main__':
    main()
