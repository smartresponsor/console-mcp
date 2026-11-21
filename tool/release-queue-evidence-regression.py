#!/usr/bin/env python3
"""Isolated queue-admission evidence regression; no production runtime required."""
import ast
import calendar
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
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("queue", "queue_pid_snapshot")]
    namespace = {"os": os, "pathlib": pathlib, "json": json, "time": time, "calendar": calendar}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), "exec"), namespace)
    return namespace


class QueueEvidenceTests(unittest.TestCase):
    def check_case(self, status, pid, exists, blocked, stale, proc_error=None, expected_identity=None, start_ticks=100000):
        with tempfile.TemporaryDirectory(prefix="release-queue-evidence-") as tmp:
            root = pathlib.Path(tmp)
            state = root / "state.json"
            state.write_text(json.dumps({"status": status, "pid": pid, "startedAt": "2026-11-16T12:00:00.000Z"}), encoding="utf-8")
            ns = load_queue()
            ns["B"] = root
            real_glob = pathlib.Path.glob
            real_exists = pathlib.Path.exists
            real_read_text = pathlib.Path.read_text

            def fake_glob(path, pattern):
                if str(path) == "/var/lib/console-mcp/run/engine/task" and pattern == "*.json":
                    return [state]
                return real_glob(path, pattern)

            def fake_exists(path):
                if str(path).startswith("/proc/"):
                    return exists
                return real_exists(path)

            def fake_read_text(path, *args, **kwargs):
                if str(path) == "/proc/uptime":
                    return "2000.0 2000.0"
                if str(path).startswith("/proc/") and str(path).endswith("/stat"):
                    if proc_error == "malformed":
                        return "malformed"
                    if proc_error == "permission":
                        raise PermissionError(str(path))
                    if not exists:
                        raise FileNotFoundError(str(path))
                    return "12345 (test) S " + " ".join(["0"] * 18) + f" {start_ticks} 42 0"
                return real_read_text(path, *args, **kwargs)

            with patch.object(pathlib.Path, "glob", fake_glob), \
                 patch.object(pathlib.Path, "exists", fake_exists), \
                 patch.object(pathlib.Path, "read_text", fake_read_text), \
                 patch.object(os, "walk", return_value=[]), \
                 patch.object(os, "sysconf", return_value=100), \
                 patch.object(time, "time", return_value=calendar.timegm((2026, 11, 16, 12, 0, 0, 0, 0, 0)) + 1000):
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
                self.assertEqual(detail["pidStartTicks"], str(start_ticks) if pid and exists and not proc_error else None)
                expected_error = {"permission": "PermissionError", "malformed": "ValueError"}.get(proc_error)
                self.assertEqual(detail["pidSnapshotError"], expected_error or ("INVALID_PID" if not pid else None))
                self.assertEqual(detail["pidIdentity"], expected_identity or ("UNVERIFIABLE" if proc_error or not pid else "PLAUSIBLE"))

    def test_live_running_blocks(self):
        self.check_case("running", 12345, True, True, False)

    def test_dead_running_does_not_block(self):
        self.check_case("running", 12345, False, False, True)

    def test_missing_pid_fails_closed(self):
        self.check_case("running", None, False, True, False)

    def test_permission_denied_fails_closed(self):
        self.check_case("running", 12345, True, True, False, proc_error="permission")

    def test_malformed_proc_stat_fails_closed(self):
        self.check_case("running", 12345, True, True, False, proc_error="malformed")

    def test_pid_reuse_mismatch_fails_closed(self):
        self.check_case("running", 12345, True, True, False, expected_identity="MISMATCH_OR_AMBIGUOUS", start_ticks=500000)

    def test_waiting_user_is_not_active(self):
        self.check_case("waiting_user", 12345, True, False, False)

    def test_terminal_timeout_is_not_active(self):
        self.check_case("timed_out", 12345, True, False, False)


if __name__ == "__main__":
    unittest.main()
