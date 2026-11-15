# M2: administrator-gated SSH read-only diagnostics (Scrapli)

**State:** Draft PR #220. SSH **not enabled in production**. No actual network device connection has been performed.

## Canonical architecture

`ChatGPT → Network Facade → Console MCP canonical registry → bounded Node adapter → Python Scrapli protocol worker → preapproved SSH endpoint`.

The Python worker is **not** a separate MCP server and does not publish MCP tools. The primary ChatGPT Console MCP projection continues to exclude all `read_.network.*` commands. Two new commands:
- `read_.network.ssh.capability` — readiness status without enumerating targets or secrets.
- `read_.network.ssh.inspect` — accepts only `targetId` and one of `version|interfaces|neighbors`.

The user/agent **cannot supply** address, port, username, key path, command text, shell script, or SSH options. The Python worker chooses one of three fixed `show` commands for a preapproved vendor driver; no configuration-mode or write method is available. Device credentials **must independently be read-only**; classifying a CLI command as read-only does not establish its actual authorization level.

## Deliberate opt-in provisioning

Absent any dependency or policy, the runtime returns `SSH_ENGINE_UNAVAILABLE` and does not attempt a TCP connection. On Windows the current adapter explicitly reports `SSH_PLATFORM_NOT_PROVISIONED`. Nothing is auto-installed, and configuration is never exposed to ChatGPT.

The installed worker requires:
- A separately reviewed Python venv executable at `/opt/console-mcp-network/venv/bin/python3` with pinned, security-reviewed Scrapli dependency; candidate version: `scrapli==2026.11.12`. Confirm compatible package provenance before installation.
- Root-owned `/etc/console-mcp/network-ssh-targets.json` with mode `0640`, group `console-mcp`; source does not accept an environment override to this path. Maximum 32 targets; max 32 KiB.
- Root-owned `/etc/console-mcp/network-ssh-known-hosts` with mode `0640` and group `console-mcp`, containing independently verified/pinned SSH host key records for every exact IP/port.
- Per-target SSH private keys under `/etc/console-mcp/network-ssh-keys/NAME`, owner root, group `console-mcp`, mode `0640`. No password supplied by ChatGPT; no SSH agent or interactive input.
- Direct, authorized endpoint connectivity from the selected Console MCP node; preexisting network restrictions and outbound firewall rules remain authoritative.

Example **schema only**, not a credential:
```json
{
  "schemaVersion": 1,
  "targets": {
    "lab_switch": {
      "ipv4": "192.0.2.12",
      "port": 22,
      "platform": "iosxe",
      "username": "readonly",
      "keyName": "lab_ro"
    }
  }
}
```
`192.0.2.12` is RFC 5737 documentation-only. Do not send a request to this address. Provision exact owned device IP and reviewed credentials through a separate administrator change. Supported drivers: iosxe, iosxr, nxos, eos, junos.

## Security constraints

- Worker input: exactly `targetId` and `observation`; invalid or unknown values fail closed.
- The selected target must use a literal valid IPv4 address in the administrator inventory. No DNS names, wildcard, scanning, local loopback, multicast, link-local, unbounded targets, or URL-derived destinations.
- Strict SSH host-key validation is mandatory (`auth_strict_key=True`); system SSH config disabled and exact known-hosts file provided.
- SSH engine invocation uses a fixed absolute interpreter path, `shell:false`, no command-line secrets, stdin JSON only. Output size cap 8 KiB, process stdout cap 16 KiB, operation deadline 25 seconds. Exceptions are sanitized rather than streamed from the SSH transport.
- Only `show version`, vendor interface-status command, and `show lldp neighbors` are mapped. **No arbitrary `send_command` argument**, `send_config`, change, reload, reset, file upload, or shell.
- Any real command output may contain device metadata, serial numbers, topology and addresses; avoid forwarding it to untrusted recipients. The worker performs basic inline-secret redaction, not a formal DLP guarantee.
- Linux-first. Windows support is an explicit separate milestone; do not claim active Windows parity for SSH.

## Admission and acceptance

At M2 candidate registry size 323, Network Facade projected size 7, primary ChatGPT tool count unchanged. Test denial for injected host/command/credential, command allowlist, missing administrative policy, Python/Node adapter timeout/output bounds, exact MCP projections including facade-disabled and main `tools/call` denial, and Linux/Windows capability differences. No live SSH test until a specific authorized lab switch is provisioned with pinned host key and read-only credentials.

**Production remains M1:** three Network tools and a separate existing OpenAI Tunnel. PR #220 stays Draft until all local tests, independent review and guarded release.

## Hardware-free Windows COM/USB Serial inventory

The existing `read_.network.serial.inventory` command now dispatches by OS within **the same canonical Console MCP runtime**. Linux remains passive `/dev/ttyUSB*`/`/dev/ttyACM*` + sysfs; Windows uses a fixed local PowerShell 7 script `tool/network-windows-serial-inventory.ps1` and Windows CIM classes `Win32_PnPEntity` (`PNPClass='Ports'`) and `Win32_SerialPort` for legacy ports. No COM handle is opened, no DTR/RTS, no baud-rate modification, no serial data transmitted.

The Windows response includes COM device name, friendly name, vendor/manufacturer, transport (`usb`, `bluetooth`, or `unknown`), optional USB VID/PID, and reported status. Full PnP identifiers and any credentials are deliberately omitted. Adapter performs strict input/output validation, a 64-port cap, a 64KiB response cap, and a 15-second deadline; malformed outputs fail closed. Port appearance does **not** prove any device is safe or ready for active serial sessions.

**Observed hardware-free acceptance (Windows Silver):** Windows CIM enumeration returned four existing Bluetooth serial ports (COM3–COM6). This validates the read-only inventory path, **not** a physical USB-to-serial adapter nor a serial session. Windows USB adapter probing and interactive serial-console transport remain separate acceptance items. GitHub #224 tracks the physical switch SSH integration independently.
