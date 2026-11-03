#!/usr/bin/python3
"""Mount-view unit static and adversarial filesystem regression (no root/mount required)."""
import importlib.util
from pathlib import Path
import tempfile

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("view_mount_plan", here / "release-view-mount-plan.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
unit = module.unit_contract()
assert unit["unitName"] == "home-alex-smartresponse-mcp-.releases.mount"
assert "ro" in unit["options"] and "bind" in unit["options"]
with tempfile.TemporaryDirectory(prefix="release-view-attack-") as t:
    root = Path(t)
    source, parent = root / "sealed", root / "mutable"
    source.mkdir()
    parent.mkdir()
    view = parent / ".releases"
    view.mkdir()
    chain = module.ancestor_chain(view)
    assert any(not x["trusted"] for x in chain)
    view.rename(parent / ".releases-old")
    (parent / ".releases").symlink_to(source, target_is_directory=True)
    assert module.ancestor_chain(view)[0]["symlink"] is True
    assert module.ancestor_chain(view)[0]["trusted"] is False
    # No user-controlled path is allowed to become production authority.
    assert module.readiness()["installAuthorized"] is False
    assert module.readiness()["runtimeCutoverAuthorized"] is False
    good = (here.parent / "systemd" / unit["unitName"]).read_text()
    for mutation in ("Options=bind,rw,nosuid,nodev,noexec", "Options=bind,ro",):
        altered = root / "tampered.mount"
        altered.write_text(good.replace("Options=bind,ro,nosuid,nodev,noexec", mutation))
        try:
            module.unit_contract(altered)
        except RuntimeError as exc:
            assert str(exc) == "MOUNT_UNIT_WEAK_OPTIONS"
        else:
            raise AssertionError("weak mount options accepted")
print("RELEASE_VIEW_MOUNT_SECURITY_REGRESSION_GREEN")
