#!/usr/bin/python3
"""Deterministic demonstration of the remaining rename-after-check race."""
import hashlib
import importlib.util
import pathlib
import tempfile
import os
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("safe_replace", "ops/ubuntu/deployment/safe-replace.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix="safe-replace-race-", dir="/tmp") as temp:
    root = pathlib.Path(temp)
    workspace = root / "workspace"
    workspace.mkdir()
    target = workspace / "file.txt"
    target.write_text("before")
    moved = root / "relocated"
    actual_replace = module.os.replace
    def adversarial_replace(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
        # Attacker renames the directory after the final identity check.
        os.rename(workspace, moved)
        return actual_replace(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
    request = {"workspace": str(workspace), "path": str(target),
               "before_sha256": hashlib.sha256(b"before").hexdigest(), "updated": "after"}
    with patch.object(module.os, "replace", side_effect=adversarial_replace):
        result = module.replace(request)
    assert result["ok"] and (moved / "file.txt").read_text() == "after"
    assert not workspace.exists()
    print("RACE_CONFIRMED: directory relocation after identity check redirects atomic commit")
