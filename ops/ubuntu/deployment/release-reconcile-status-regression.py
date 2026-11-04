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
            (base / 'registry.json').write_text(__import__('json').dumps({'sourceSHA': active}))
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

    def test_missing_desired(self):
        self.check(None, 'a' * 40, 'committed', 'BLOCKED')

    def test_missing_registry(self):
        self.check('a' * 40, None, 'committed', 'BLOCKED')


if __name__ == '__main__':
    unittest.main()
