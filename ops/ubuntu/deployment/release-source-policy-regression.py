#!/usr/bin/env python3
"""Hermetic advisory policy regression tests."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('source_policy', Path(__file__).with_name('release-source-policy.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = {'schemaVersion': 1, 'enabled': True, 'repository': 'https://github.com/example/repo.git',
                       'ref': 'refs/heads/master', 'trustedSigners': ['trusted'], 'requiredChecks': ['build', 'admission']}
        self.evidence = {'repository': self.policy['repository'], 'ref': self.policy['ref'], 'sha': 'a' * 40,
                         'sourceVerified': True, 'protectedBranchVerified': True, 'signatureVerified': True,
                         'signer': 'trusted', 'checks': {'build': True, 'admission': True}}

    def test_advisory_success(self):
        self.assertEqual(module.evaluate(self.policy, self.evidence)['action'], 'NO_MUTATION')
        self.assertTrue(module.evaluate(self.policy, self.evidence)['eligible'])

    def test_version(self):
        self.policy['schemaVersion'] = 2
        self.assertFalse(module.evaluate(self.policy, self.evidence)['eligible'])

    def test_disabled(self):
        self.policy['enabled'] = False
        self.assertFalse(module.evaluate(self.policy, self.evidence)['eligible'])

    def test_repository_substitution(self):
        self.evidence['repository'] = 'https://evil.example/repo.git'
        self.assertEqual(module.evaluate(self.policy, self.evidence)['reasonCode'], 'SOURCE_IDENTITY_MISMATCH')

    def test_ref_substitution(self):
        self.evidence['ref'] = 'refs/heads/feature'
        self.assertEqual(module.evaluate(self.policy, self.evidence)['reasonCode'], 'SOURCE_IDENTITY_MISMATCH')

    def test_sha(self):
        self.evidence['sha'] = 'invalid'
        self.assertEqual(module.evaluate(self.policy, self.evidence)['reasonCode'], 'SOURCE_SHA_INVALID')

    def test_provenance(self):
        self.evidence['protectedBranchVerified'] = False
        self.assertEqual(module.evaluate(self.policy, self.evidence)['reasonCode'], 'SOURCE_PROVENANCE_UNVERIFIED')

    def test_signature(self):
        self.evidence['signer'] = 'untrusted'
        self.assertEqual(module.evaluate(self.policy, self.evidence)['reasonCode'], 'SOURCE_SIGNER_UNTRUSTED')

    def test_checks(self):
        self.evidence['checks']['admission'] = False
        self.assertEqual(module.evaluate(self.policy, self.evidence)['reasonCode'], 'SOURCE_REQUIRED_CHECKS_MISSING')

    def test_missing_evidence(self):
        self.assertFalse(module.evaluate(self.policy, None)['eligible'])


if __name__ == '__main__':
    unittest.main()
