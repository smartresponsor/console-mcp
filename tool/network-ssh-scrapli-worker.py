#!/usr/bin/python3
"""Network MCP read-only SSH worker using Scrapli.

No arbitrary CLI, host, credential, SSH options, or filesystem paths in user input.
SSH targets are provisioned by an administrator, fail-closed by default.
The worker is invoked by the canonical Console MCP, not by a second MCP server.
"""
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys

POLICY = Path("/etc/console-mcp/network-ssh-targets.json")
KNOWN_HOSTS = Path("/etc/console-mcp/network-ssh-known-hosts")
KEY_ROOT = Path("/etc/console-mcp/network-ssh-keys")
TARGET = re.compile(r"^[a-z][a-z0-9_-]{0,47}$")
PLATFORMS = ("iosxe", "iosxr", "nxos", "eos", "junos")
COMMANDS = {
    "iosxe": {"version": "show version", "interfaces": "show ip interface brief", "neighbors": "show lldp neighbors"},
    "iosxr": {"version": "show version", "interfaces": "show ipv4 interface brief", "neighbors": "show lldp neighbors"},
    "nxos": {"version": "show version", "interfaces": "show interface brief", "neighbors": "show lldp neighbors"},
    "eos": {"version": "show version", "interfaces": "show interfaces status", "neighbors": "show lldp neighbors"},
    "junos": {"version": "show version", "interfaces": "show interfaces terse", "neighbors": "show lldp neighbors"},
}
MAX_REPLY = 8192


class Refused(Exception):
    """Sanitized error: never expose credentials or SSH transport logs."""


def secure_regular_file(path, *, owner_ids=(0,), allow_group_read=True):
    """Fail closed on symlink, unsafe owner or group/other write and other-read."""
    try:
        info = path.lstat()
    except OSError as exc:
        raise Refused("CONFIGURATION_UNAVAILABLE") from exc
    if not stat.S_ISREG(info.st_mode) or info.st_uid not in owner_ids:
        raise Refused("CONFIGURATION_UNTRUSTED")
    forbidden = 0o022 | 0o004
    if not allow_group_read:
        forbidden |= 0o040
    if info.st_mode & forbidden:
        raise Refused("CONFIGURATION_PERMISSIONS_UNSAFE")


def verified_policy():
    secure_regular_file(POLICY)
    secure_regular_file(KNOWN_HOSTS)
    try:
        content = POLICY.read_bytes()
        if len(content) > 32768:
            raise Refused("POLICY_TOO_LARGE")
        policy = json.loads(content)
    except (OSError, UnicodeError, ValueError) as exc:
        raise Refused("POLICY_INVALID") from exc
    if not isinstance(policy, dict) or set(policy) != {"schemaVersion", "targets"} or policy["schemaVersion"] != 1:
        raise Refused("POLICY_INVALID")
    targets = policy["targets"]
    if not isinstance(targets, dict) or len(targets) > 32:
        raise Refused("POLICY_INVALID")
    return targets


def authorized_target(targets, target_id):
    if not isinstance(target_id, str) or not TARGET.fullmatch(target_id):
        raise Refused("TARGET_ID_INVALID")
    target = targets.get(target_id)
    if not isinstance(target, dict) or set(target) != {"ipv4", "port", "platform", "username", "keyName"}:
        raise Refused("TARGET_NOT_AUTHORIZED")
    addr = target["ipv4"]
    try:
        ip = ipaddress.IPv4Address(addr)
    except (ValueError, TypeError) as exc:
        raise Refused("TARGET_ADDRESS_INVALID") from exc
    if ip.is_loopback or ip.is_multicast or ip.is_unspecified or ip.is_link_local or ip.is_reserved:
        raise Refused("TARGET_ADDRESS_FORBIDDEN")
    port = target["port"]
    if type(port) is not int or not 1 <= port <= 65535:
        raise Refused("TARGET_PORT_INVALID")
    if target["platform"] not in PLATFORMS:
        raise Refused("TARGET_PLATFORM_UNSUPPORTED")
    username = target["username"]
    key_name = target["keyName"]
    if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,47}", username):
        raise Refused("TARGET_USER_INVALID")
    if not isinstance(key_name, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,48}", key_name):
        raise Refused("CREDENTIAL_REFERENCE_INVALID")
    key = KEY_ROOT / key_name
    secure_regular_file(key)
    return {**target, "ipv4": str(ip), "keyPath": str(key)}


def decide(request, targets):
    if not isinstance(request, dict) or set(request) != {"targetId", "observation"}:
        raise Refused("REQUEST_INVALID")
    target = authorized_target(targets, request["targetId"])
    observation = request["observation"]
    if not isinstance(observation, str) or observation not in COMMANDS[target["platform"]]:
        raise Refused("OBSERVATION_NOT_PERMITTED")
    return target, COMMANDS[target["platform"]][observation]


def observe(request):
    targets = verified_policy()
    target, command = decide(request, targets)
    try:
        from scrapli.driver.core import (
            IOSXEDriver, IOSXRDriver, NXOSDriver, EOSDriver, JunosDriver,
        )
    except ImportError as exc:
        raise Refused("SCRAPLI_DEPENDENCY_UNAVAILABLE") from exc
    drivers = {"iosxe": IOSXEDriver, "iosxr": IOSXRDriver, "nxos": NXOSDriver,
               "eos": EOSDriver, "junos": JunosDriver}
    kwargs = dict(
        host=target["ipv4"], port=target["port"], auth_username=target["username"],
        auth_private_key=target["keyPath"], auth_strict_key=True,
        ssh_known_hosts_file=str(KNOWN_HOSTS), ssh_config_file=False,
        transport="system", timeout_socket=5, timeout_transport=10, timeout_ops=8,
    )
    try:
        with drivers[target["platform"]](**kwargs) as client:
            result = client.send_command(command)
            if result.failed:
                raise Refused("DIAGNOSTIC_COMMAND_FAILED")
            text = str(result.result)
    except Refused:
        raise
    except Exception as exc:
        # No exception messages: may contain hostnames, credentials, or SSH banner.
        raise Refused("AUTHORIZED_SSH_DIAGNOSTIC_FAILED") from exc
    encoded = text.encode("utf-8", errors="replace")
    shortened = len(encoded) > MAX_REPLY
    safe = encoded[:MAX_REPLY].decode("utf-8", errors="replace")
    # Preserve diagnostics without directly disclosing common inline secrets.
    safe = re.sub(r"(?im)^.*(?:password|private.key|secret|token)\s*[:=].*$",
                  "[REDACTED_SENSITIVE_LINE]", safe)
    return {"ok": True, "status": "SSH_READ_ONLY_RESULT", "targetId": request["targetId"],
            "observation": request["observation"], "platform": target["platform"],
            "output": safe, "truncated": shortened}


def main():
    try:
        raw = sys.stdin.buffer.read(2049)
        if len(raw) > 2048:
            raise Refused("REQUEST_TOO_LARGE")
        request = json.loads(raw)
        result = observe(request)
    except Refused as exc:
        result = {"ok": False, "status": str(exc)}
    except (ValueError, UnicodeError):
        result = {"ok": False, "status": "REQUEST_INVALID"}
    except Exception:
        result = {"ok": False, "status": "SSH_WORKER_INTERNAL_ERROR"}
    print(json.dumps(result, separators=(",", ":"), ensure_ascii=True))


if __name__ == "__main__":
    main()
