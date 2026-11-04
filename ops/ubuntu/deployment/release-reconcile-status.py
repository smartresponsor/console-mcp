#!/usr/bin/env python3
"""Read-only desired/active release reconciliation; never mutates production."""
import json
import pathlib
import subprocess

BASE = pathlib.Path('/opt/console-mcp-deploy')
REPO = pathlib.Path('/home/alex/smartresponse/mcp/console-mcp')


def git(*args):
    result = subprocess.run(['git', '-C', str(REPO), *args], capture_output=True,
                            text=True, timeout=15, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def status():
    desired = git('rev-parse', '--verify', 'refs/remotes/origin/master^{commit}')
    try:
        registry = json.loads((BASE / 'registry.json').read_text())
    except (OSError, ValueError):
        registry = {}
    candidate = registry.get('sourceSHA')
    active = registry.get('sourceSHA')
    try:
        journal = json.loads((BASE / 'transaction.json').read_text())
        phase = journal.get('phase')
        if phase == 'committed' and journal.get('candidate') != registry.get('candidate'):
            phase = 'registry_mismatch'
        elif phase == 'committed' and journal.get('sourceSHA') != active:
            phase = 'registry_mismatch'
    except (OSError, ValueError):
        phase = None
    if not desired:
        state, reason = 'BLOCKED', 'DESIRED_SHA_UNAVAILABLE'
    elif not active:
        state, reason = 'BLOCKED', 'REGISTRY_SHA_UNAVAILABLE'
    elif phase != 'committed':
        state, reason = 'BLOCKED', 'TRANSACTION_REVIEW_REQUIRED'
    elif active == desired:
        state, reason = 'REGISTERED_CURRENT', 'LIVE_RUNTIME_IDENTITY_UNVERIFIED'
    else:
        state, reason = 'UPDATE_AVAILABLE', 'REGISTRY_CANDIDATE_BEHIND_MASTER'
    return {'status': state, 'reasonCode': reason, 'desiredSHA': desired,
            'registeredCandidateSHA': candidate, 'registrySourceSHA': active, 'transactionPhase': phase,
            'action': 'NO_MUTATION_READ_ONLY_OBSERVER'}


if __name__ == '__main__':
    print(json.dumps(status(), sort_keys=True))
