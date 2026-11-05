#!/usr/bin/env python3
"""Pure advisory evaluator. Evidence MUST be authenticated by a future root controller."""
import re

SHA = re.compile(r'^[0-9a-f]{40}$')


def evaluate(policy, evidence):
    def deny(reason):
        return {'eligible': False, 'reasonCode': reason, 'action': 'NO_MUTATION'}
    if not isinstance(policy, dict) or policy.get('schemaVersion') != 1 or policy.get('enabled') is not True:
        return deny('SOURCE_POLICY_INVALID')
    if not isinstance(evidence, dict):
        return deny('SOURCE_EVIDENCE_INVALID')
    repository, ref = policy.get('repository'), policy.get('ref')
    if not isinstance(repository, str) or not repository.startswith('https://') or not repository.endswith('.git') or ref != 'refs/heads/master':
        return deny('SOURCE_IDENTITY_INVALID')
    signers, required = policy.get('trustedSigners'), policy.get('requiredChecks')
    if any(not isinstance(v, list) or not v or any(not isinstance(x, str) or not x for x in v) for v in (signers, required)):
        return deny('SOURCE_POLICY_INVALID')
    if evidence.get('repository') != repository or evidence.get('ref') != ref:
        return deny('SOURCE_IDENTITY_MISMATCH')
    sha = evidence.get('sha')
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        return deny('SOURCE_SHA_INVALID')
    if evidence.get('sourceVerified') is not True or evidence.get('protectedBranchVerified') is not True:
        return deny('SOURCE_PROVENANCE_UNVERIFIED')
    if evidence.get('signatureVerified') is not True or evidence.get('signer') not in signers:
        return deny('SOURCE_SIGNER_UNTRUSTED')
    checks = evidence.get('checks')
    if not isinstance(checks, dict) or any(checks.get(name) is not True for name in required):
        return deny('SOURCE_REQUIRED_CHECKS_MISSING')
    return {'eligible': True, 'reasonCode': 'SOURCE_POLICY_EVIDENCE_MATCH', 'sha': sha, 'action': 'NO_MUTATION'}
