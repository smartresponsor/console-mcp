#!/usr/bin/python3
"""Offline security regression for read-only Scrapli network worker.

Never imports Scrapli, contacts a host, or reads real credential files.
"""
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

WORKER = pathlib.Path(__file__).with_name("network-ssh-scrapli-worker.py")
spec = importlib.util.spec_from_file_location("network_ssh_worker", WORKER)
assert spec is not None and spec.loader is not None
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

TARGETS = {
    "lab_switch": {
        "ipv4": "192.0.2.12", "port": 22, "platform": "iosxe",
        "username": "readonly", "keyName": "lab_ro",
    }
}


class SecurityContract(unittest.TestCase):
    def setUp(self):
        self.secure = patch.object(worker, "secure_regular_file").start()
        self.addCleanup(patch.stopall)

    def test_explicit_allowlist_read_only_commands(self):
        for obs in ("version", "interfaces", "neighbors"):
            target, command = worker.decide({"targetId": "lab_switch", "observation": obs}, TARGETS)
            self.assertEqual(target["keyPath"], str(worker.KEY_ROOT / "lab_ro"))
            self.assertTrue(command.startswith("show "))
            self.assertNotIn("configure", command.lower())

    def test_request_cannot_supply_host_user_or_command(self):
        blocked = [
            {"targetId": "lab_switch", "observation": "version", "command": "reload"},
            {"targetId": "lab_switch", "observation": "show running-config"},
            {"targetId": "lab_switch", "observation": "version", "host": "8.8.8.8"},
            {"targetId": "../etc", "observation": "version"},
            {"targetId": "not_authorized", "observation": "version"},
        ]
        for item in blocked:
            with self.subTest(item=item), self.assertRaises(worker.Refused):
                worker.decide(item, TARGETS)

    def test_static_ipv4_and_credential_reference_restrictions(self):
        for field, value in (
            ("ipv4", "localhost"), ("ipv4", "127.0.0.1"),
            ("ipv4", "::1"), ("port", 0), ("port", True),
            ("username", "root;touch /tmp/x"), ("keyName", "../../id_ed25519"),
            ("platform", "unknown"),
        ):
            target = dict(TARGETS["lab_switch"])
            target[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(worker.Refused):
                worker.decide({"targetId": "lab_switch", "observation": "version"}, {"lab_switch": target})

    def test_no_write_operations_in_any_platform_table(self):
        self.assertEqual(set(worker.PLATFORMS), set(worker.COMMANDS))
        for platform, commands in worker.COMMANDS.items():
            self.assertEqual(set(commands), {"version", "interfaces", "neighbors"})
            for command in commands.values():
                self.assertTrue(command.startswith("show "), (platform, command))
                self.assertNotIn("password", command.lower())
                self.assertNotIn("secret", command.lower())

    def test_fail_closed_when_policy_not_provisioned(self):
        self.secure.side_effect = worker.Refused("CONFIGURATION_UNAVAILABLE")
        output = worker_main_request({"targetId": "lab_switch", "observation": "version"})
        self.assertEqual(output["ok"], False)
        self.assertEqual(output["status"], "CONFIGURATION_UNAVAILABLE")


def worker_main_request(request):
    # Explicitly exercise only the authorization branch, never a transport.
    try:
        targets = worker.verified_policy()
        worker.decide(request, targets)
    except worker.Refused as exc:
        return {"ok": False, "status": str(exc)}
    raise AssertionError("unconfigured environment unexpectedly authorized SSH")


if __name__ == "__main__":
    unittest.main()
