#!/usr/bin/python3
"""Nonprivileged fail-closed test of real kernel mount test runner output."""
import importlib.util
from pathlib import Path
from unittest.mock import patch
import subprocess
spec = importlib.util.spec_from_file_location("mntns", Path(__file__).with_name("release-view-namespace-test.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with patch.object(m.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "unshare: Operation not permitted")):
    result = m.test()
    assert result["status"] == "KERNEL_NAMESPACE_TEST_BLOCKED"
    assert result["gatePassed"] is False and result["productionCutoverAuthorized"] is False
with patch.object(m.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "bad-json", "")):
    result = m.test()
    assert result["gatePassed"] is False
with patch.object(m.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, '{"isolatedNamespace":true,"readOnlyBindVerified":true,"productionRootTrusted":false}', "")):
    result = m.test()
    assert result["gatePassed"] and not result["productionCutoverAuthorized"]
print("NAMESPACE_GATE_FAIL_CLOSED_GREEN")
