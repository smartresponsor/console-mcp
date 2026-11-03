#!/usr/bin/python3
"""Nonprivileged mountinfo regression; never needs mount, root, or production mutation."""
import importlib.util
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location("release_view", Path(__file__).with_name("release-view-admission.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

raw = ("21 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n"
       "42 21 8:1 /opt/console-mcp-deploy/releases /home/alex/smartresponse/mcp/.releases ro,relatime - ext4 /dev/sda1 rw\n")
parsed = mod.mountinfo(raw)
assert len(parsed) == 2
assert mod.mount_at(mod.VIEW, parsed)["id"] == 42
for unsafe in ["21 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n",
               "42 21 8:1 /foo /home/alex/smartresponse/mcp/.releases rw - ext4 /dev/sda1 rw\n"]:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        physical = root / "physical"
        view = root / "view"
        physical.mkdir()
        view.mkdir()
        result = mod.inspect(view, physical, unsafe)
        assert result["productionCutoverAllowed"] is False
        assert result["viewTrustedAsProductionRoot"] is False
        assert result["status"] == "EXACT_MOUNT_NOT_VERIFIED"
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    physical = root / "physical"
    view = root / "view"
    physical.mkdir()
    view.mkdir()
    data = ("42 21 8:1 /foo " + str(view) + " ro - ext4 /dev/sda1 rw\n")
    result = mod.inspect(view, physical, data)
    assert result["status"] == "MOUNT_IDENTITY_MISMATCH"
    assert result["productionCutoverAllowed"] is False
    data_rw = ("42 21 8:1 /foo " + str(view) + " rw - ext4 /dev/sda1 rw\n")
    assert mod.inspect(view, physical, data_rw)["status"] == "VIEW_MOUNT_NOT_READ_ONLY"
print("RELEASE_VIEW_ADMISSION_NEGATIVE_GATES_GREEN")
