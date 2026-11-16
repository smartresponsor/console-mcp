#!/usr/bin/env python3
"""Isolated queue-admission evidence regression; no production runtime required."""
import ast
import json
import os
import pathlib
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "ops/ubuntu/deployment/gates.py"


def load_queue():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "queue")
    namespace = {"os": os, "pathlib": pathlib, "json": json, "time": time}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(SOURCE), "exec"), namespace)
    return namespace


class QueueEvidenceTests(unittest.TestCase):
    def check_case(self, status, pid, exists, blocked, stale):
        with tempfile.TemporaryDirectory(prefix="release-queue-evidence-") as tmp:
            root = pathlib.Path(tmp)
            state = root / "state.json"
            state.write_text(json.dumps({"status": status, "pid": pid}), encoding="utf-8")
            ns = load_queue()
            ns["B"] = root
            real_glob = pathlib.Path.glob
            real_exists = pathlib.Path.exists

            def fake_glob(path, pattern):
                if str(path) == "/var/lib/console-mcp/run/engine/task" and pattern == "*.json":
                    return [state]
                return real_glob(path, pattern)

            def fake_exists(path):
                if str(path).startswith("/proc/"):
                    return exists
                return real_exists(path)

            with patch.object(pathlib.Path, "glob", fake_glob), \
                 patch.object(pathlib.Path, "exists", fake_exists), \
                 patch.object(os, "walk", return_value=[]):
                if blocked:
                    with self.assertRaisesRegex(RuntimeError, "task queue not empty"):
                        ns["queue"]()
                else:
                    ns["queue"]()

            evidence = json.loads((root / "queue-last.json").read_text())
            self.assertEqual(evidence["checked"], 1)
            self.assertEqual(bool(evidence["active"]), blocked)
            self.assertEqual(bool(evidence["staleDeadProcessRecords"]), stale)
            self.assertEqual(len(evidence["activeDetails"]), int(blocked))
            if blocked:
                detail = evidence["activeDetails"][0]
                self.assertEqual(detail["status"], status)
                self.assertEqual(detail["pid"], pid)
                self.assertEqual(detail["pidPresentAtScan"], bool(pid and exists))
                self.assertEqual(detail["path"], str(state))

    def test_live_running_blocks(self):
        self.check_case("running", 12345, True, True, False)

    def test_dead_running_does_not_block(self):
        self.check_case("running", 12345, False, False, True)

    def test_missing_pid_fails_closed(self):
        self.check_case("running", None, False, True, False)

    def test_waiting_user_is_not_active(self):
        self.check_case("waiting_user", 12345, True, False, False)

    def test_terminal_timeout_is_not_active(self):
        self.check_case("timed_out", 12345, True, False, False)


if __name__ == "__main__":
    unittest.main()
