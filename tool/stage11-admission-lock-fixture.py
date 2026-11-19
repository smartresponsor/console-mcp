#!/usr/bin/python3
"""Adversarial unprivileged tests; all locks exist only in temporary fixtures."""
import importlib.util
import multiprocessing as mp
import os
from pathlib import Path
import tempfile
import time

source = Path(__file__).resolve().parents[1] / "ops/ubuntu/deployment/admission-lock.py"
spec = importlib.util.spec_from_file_location("admission_lock", source)
adm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adm)


def waiter(path, mode, hold, result):
    try:
        with adm.admission(mode, path, timeout=0.4, expected_uid=os.getuid()):
            result.put("GRANTED")
            time.sleep(hold)
    except adm.AdmissionError as e:
        result.put(str(e))


def test():
    ctx = mp.get_context("spawn")
    with tempfile.TemporaryDirectory(prefix="stage11-admission-") as temp:
        base = Path(temp)
        base.chmod(0o700)
        lock = base / "admission.lock"
        lock.write_text("preprovisioned")
        lock.chmod(0o640)
        uid = os.getuid()
        with adm.admission("shared", lock, expected_uid=uid):
            with adm.admission("shared", lock, expected_uid=uid):
                pass
            result = ctx.Queue()
            proc = ctx.Process(target=waiter, args=(lock, "exclusive", 0, result))
            proc.start()
            assert result.get(timeout=2) == "ADMISSION_BUSY"
            proc.join(timeout=2)
            assert proc.exitcode == 0
        with adm.admission("exclusive", lock, expected_uid=uid):
            result = ctx.Queue()
            proc = ctx.Process(target=waiter, args=(lock, "shared", 0, result))
            proc.start()
            assert result.get(timeout=2) == "ADMISSION_BUSY"
            proc.join(timeout=2)
            assert proc.exitcode == 0
        result = ctx.Queue()
        proc = ctx.Process(target=waiter, args=(lock, "exclusive", 0.01, result))
        proc.start()
        assert result.get(timeout=2) == "GRANTED"
        proc.join(timeout=2)
        assert proc.exitcode == 0
        lock.chmod(0o642)
        try:
            with adm.admission("shared", lock, expected_uid=uid):
                raise AssertionError("world-writable lock authorized")
            raise AssertionError("world-writable lock authorized")
        except adm.AdmissionError as exc:
            assert str(exc) == "ADMISSION_LOCK_UNTRUSTED"
        lock.chmod(0o640)
        lock.unlink()
        lock.symlink_to(base / "nonexistent")
        try:
            with adm.admission("exclusive", lock, expected_uid=uid):
                raise AssertionError("symlink admitted")
            raise AssertionError("symlink admitted")
        except (OSError, adm.AdmissionError):
            pass
        lock.unlink()
        assert not lock.exists()
        try:
            with adm.admission("shared", lock, expected_uid=uid):
                raise AssertionError("missing lock should fail closed")
            raise AssertionError("missing lock admitted")
        except FileNotFoundError:
            pass
        print("STAGE11_FLOCK_MULTIPROCESS_ADVERSARIAL_PASS")


if __name__ == "__main__":
    test()
