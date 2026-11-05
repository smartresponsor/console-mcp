#!/usr/bin/env python3
"""Hermetic regression tests for the non-mutating release observer."""
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).with_name('release-reconcile-status.py')
spec = importlib.util.spec_from_file_location('release_reconcile_status', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReconciliationTests(unittest.TestCase):
    def check(self, desired, active, phase, expected):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            (base / 'transaction.json').write_text(__import__('json').dumps({'phase': phase, 'sourceSHA': active, 'candidate': 'release'}))
            (base / 'registry.json').write_text(__import__('json').dumps({'sourceSHA': active, 'candidate': 'release'}))
            with patch.object(module, 'BASE', base), patch.object(module, 'git', return_value=desired):
                result = module.status()
        self.assertEqual(result['status'], expected)
        self.assertEqual(result['action'], 'NO_MUTATION_READ_ONLY_OBSERVER')

    def test_current(self):
        self.check('a' * 40, 'a' * 40, 'committed', 'REGISTERED_CURRENT')

    def test_drift(self):
        self.check('b' * 40, 'a' * 40, 'committed', 'UPDATE_AVAILABLE')

    def test_transaction_gate(self):
        self.check('b' * 40, 'a' * 40, 'preparing', 'BLOCKED')

    def test_mismatched_transaction(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            (base / 'registry.json').write_text(__import__('json').dumps({'sourceSHA': 'a' * 40, 'candidate': 'release-a'}))
            (base / 'transaction.json').write_text(__import__('json').dumps({'phase': 'committed', 'sourceSHA': 'a' * 40, 'candidate': 'release-b'}))
            with patch.object(module, 'BASE', base), patch.object(module, 'git', return_value='a' * 40):
                result = module.status()
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['reasonCode'], 'REGISTRY_TRANSACTION_MISMATCH')

    def test_invalid_sha(self):
        self.check('invalid', 'a' * 40, 'committed', 'BLOCKED')
        self.check('a' * 40, 'invalid', 'committed', 'BLOCKED')

    def test_broker_authorization_gate(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            sha = 'a' * 40
            (base / 'registry.json').write_text(json.dumps({'sourceSHA': sha, 'candidate': 'release'}))
            (base / 'transaction.json').write_text(json.dumps({'phase': 'committed', 'sourceSHA': sha, 'candidate': 'release'}))
            policy = base / 'broker-policy.json'
            with patch.object(module, 'BASE', base), patch.object(module, 'git', return_value=sha):
                self.assertEqual(module.status()['promotionGate'], 'POLICY_UNAVAILABLE')
                policy.write_text(json.dumps({'authorizedSha': sha, 'enabledOperations': ['validate']}))
                self.assertEqual(module.status()['promotionGate'], 'NOT_AUTHORIZED')
                policy.write_text(json.dumps({'authorizedSha': sha, 'enabledOperations': ['prepare', 'validate', 'activate']}))
                self.assertEqual(module.status()['promotionGate'], 'AUTHORIZED')
                self.assertFalse(module.status()['preparationEligible'])
                with patch.object(module, 'git', return_value='b' * 40):
                    self.assertFalse(module.status()['preparationEligible'])
                policy.write_text(json.dumps({'authorizedSha': 'b' * 40, 'enabledOperations': ['prepare', 'validate', 'activate']}))
                self.assertEqual(module.status()['promotionGate'], 'NOT_AUTHORIZED')

    def test_preparation_eligibility(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            current, desired = 'a' * 40, 'b' * 40
            (base / 'registry.json').write_text(json.dumps({'sourceSHA': current, 'candidate': 'release'}))
            (base / 'transaction.json').write_text(json.dumps({'phase': 'committed', 'sourceSHA': current, 'candidate': 'release'}))
            (base / 'broker-policy.json').write_text(json.dumps({'authorizedSha': desired, 'enabledOperations': ['prepare', 'validate', 'activate']}))
            with patch.object(module, 'BASE', base), patch.object(module, 'git', return_value=desired):
                result = module.status()
                self.assertEqual(result['status'], 'UPDATE_AVAILABLE')
                self.assertTrue(result['preparationEligible'])
                self.assertEqual(result['nextAction'], 'MANUAL_REVIEW_AND_SEALED_PREPARATION')

    def test_missing_desired(self):
        self.check(None, 'a' * 40, 'committed', 'BLOCKED')

    def test_missing_registry(self):
        self.check('a' * 40, None, 'committed', 'BLOCKED')


if __name__ == '__main__':
    unittest.main()
