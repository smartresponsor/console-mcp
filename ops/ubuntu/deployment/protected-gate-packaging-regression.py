#!/usr/bin/python3
"""Fixture verifies sealed root gate dependencies are included in copied operators."""
import hashlib
import pathlib
import runpy
import shutil
import tempfile

source=pathlib.Path(__file__).resolve().parent
prepare=runpy.run_path(str(source/"prepare.py"),run_name="packaging_fixture")
operators=prepare["OPERATORS"]
assert "gates.py" in operators and "sandbox-auth-evidence.py" in operators
assert len(operators)==len(set(operators))
assert all((source / name).is_file() for name in operators)
expected={name:hashlib.sha256((source/name).read_bytes()).hexdigest() for name in operators}
with tempfile.TemporaryDirectory(prefix="protected-gate-package-") as tmp:
 root=pathlib.Path(tmp)
 for name in operators:
  shutil.copyfile(source/name, root/name)
 assert all(hashlib.sha256((root/name).read_bytes()).hexdigest()==expected[name] for name in operators)
 gates=runpy.run_path(str(root/"gates.py"),run_name="packaged_gate_fixture")
 receipt=gates["VERIFY_SANDBOX_AUTH"]
 proof={"passed":True,"authenticatedMcpSmoke":True,"sourceSHA":"candidate","candidate":"candidate","checkpoint":"gen-1","registryFingerprint":"registry","buildFingerprint":"build","advertisedToolCount":8,"pid":321,"at":100.0}
 assert receipt(proof,role="candidate",release_sha="candidate",release_id="candidate",checkpoint="gen-1",registry_fingerprint="registry",expected_build="build",now=101.0) is True
 (root/"sandbox-auth-evidence.py").unlink()
 try:runpy.run_path(str(root/"gates.py"),run_name="packaged_gate_fixture_missing_dependency")
 except FileNotFoundError:pass
 else:raise AssertionError("missing protected helper was not detected")
print("PROTECTED_GATE_PACKAGING_GREEN: protected helper sealed, copied, hash-checked and required")
