# Network M2 — Serial driver safety and hardware admission matrix

**Status:** RESEARCH / NO DEVICE OPEN AUTHORIZATION. Relates to [#238](https://github.com/smartresponsor/console-mcp/issues/238), [#227](https://github.com/smartresponsor/console-mcp/issues/227), and the independent bench-evidence intake [PR #262](https://github.com/smartresponsor/console-mcp/pull/262).

## Critical separation

The following assertions must be proven **independently** before permitting any physical serial capture:
1. **Pre-open electrical safety:** no DTR/RTS/break/glitch during discovery, attach, driver activation, open, read, cancel, close or device removal. Merely setting lines to false *after* obtaining a handle is too late.
2. **Handle-bound identity:** the kernel/driver proves the actual open handle refers to the admin-pinned device/interface; pre-open path, sysfs, COM mapping and injected witness are not sufficient against TOCTOU.
3. **OS-enforced read-only discipline:** no writes, serial break, baud/framing/control mutations, implicit login or auto-negotiation.
4. **Close/cleanup attestation:** physical handle closed, session lease held until close completes, unplug/driver fault and cancellation handled without orphaned state.
5. **Measured, independently reviewed bench evidence:** a device/driver-specific electrical test; proof hashes must be checked against actual owned artifacts, not treated as evidence merely because syntactically valid.

## Platform matrix

| Platform / operation | Grounded behavior | Consequence |
|---|---|---|
| Linux TTY `open(2)` / `tty_port_open()` | Generic tty-port open/ready handling can call `tty_port_raise_dtr_rts`; source contains a branch doing this even for non-blocking open. | `O_NONBLOCK`, `O_NOCTTY`, `O_CLOEXEC`, read-only access, or a later `termios`/ioctl are **not** independently a no-toggle proof. |
| Linux close/hangup | TTY shutdown may lower lines when `HUPCL` is set. | Initial, cancellation, and last-close transitions need instrumented review; toggling `HUPCL` after open does not prove pre-open safety. |
| Linux identity | Before-open `/dev`/sysfs metadata can drift; `fstat` proves properties of a file descriptor but not USB interface electrical safety. | Verify kernel handle identity plus stable device/port ancestry, driver binding and generation, using trusted native privileged code; reject unsupported drivers and hotplug churn. |
| Windows serial `CreateFile()` | COM resource configuration inherits settings from its previous open or system defaults when first opened. | Neither `GENERIC_READ` nor subsequent `GetCommState` / `SetCommState` guarantees DTR/RTS did not transition during `CreateFile`. |
| Windows modem control | `EscapeCommFunction` exposes explicit SET/CLR DTR/RTS operations on an **already-open** handle. | Post-open `CLRDTR`/`CLRRTS` is not a pre-open no-toggle control. Do not call it in passive inventory or admission. |
| Windows identity | PnP `InstanceId` ↔ `PortName` registry mapping is **pre-open** metadata. | Validate identity through a driver-supported OS handle binding and device interface before reading; do not infer from COM number alone. |

## Hardware bench acceptance protocol — **not executable by an MCP request**

1. Offline operator signs a per-device bench plan (platform, exact adapter model, VID/PID/interface/serial where present, driver name/version, OS/kernel build, machine, capture date and safe isolated load).
2. **Instrument first**, before attach/open: use an independent oscilloscope/logic analyzer on DTR, RTS, TX, break and ground; agree safe voltage levels and recording trigger so sub-millisecond impulses are visible. Record attach, open, cancellation, unplug and close, including cold and warm states.
3. Verify that no line transitions or outbound bytes occur throughout each lifecycle phase, not just steady-state levels. If any transition occurs or measurement coverage is incomplete, result is **DENY** for that device/driver.
4. On a separately authorized disposable bench target, attest the real opened kernel/PnP handle identity, USB interface, driver binding/version and hotplug generation; repeat before and after capture. Mismatch, uncertain provenance, or inconclusive OS support is **DENY**.
5. Demonstrate bounded read, forbidden writes, timeouts/abort/close, lease held through cleanup and fault injection. Validate secret redaction across fragmented frames. Record complete traces, hashes of measured artifacts, signatures and independent review.
6. Bench evidence intake may report *syntactic completeness* only; it must **not** return `mayOpenDevice:true`. Actual authorization requires a distinct security-reviewed privileged implementation, explicit operator approval and release process, not a manifest flag.

## Baseline decision

| Candidate | Current disposition |
|---|---|
| Passive Linux/Windows inventory and metadata preflight | **ALLOW metadata only**; never acquire a physical serial handle |
| Offline PTY and mock handle fixture | **ALLOW test-only**; not equivalent to USB/COM driver electrical behavior |
| Generic Linux USB serial driver and arbitrary /dev/ttyUSB* | **DENY active open** until model-specific pre-open no-toggle proof |
| Generic Windows COM including Bluetooth virtual ports | **DENY active open** until model/driver-specific pre-open no-toggle proof |
| Claimed signed evidence manifest / approved request / stable COM mapping | **DENY active open**; these are not kernel-handle or electrical attestation |
| Proposed real capture with unknown hardware or without an external line analyzer | **DENY active open** |

**Keep `assessPhysicalSerialReadiness(...).mayOpenDevice === false` unchanged.** No new native open API, no MCP registration and no production activation is within scope of this document.

## Primary references

- Linux kernel TTY Port API: https://www.kernel.org/doc/html/latest/driver-api/tty/tty_port.html
- Linux kernel implementation `drivers/tty/tty_port.c` (`tty_port_block_til_ready`, `tty_port_raise_dtr_rts`): https://github.com/torvalds/linux/blob/master/drivers/tty/tty_port.c
- Microsoft, Modification of Communications Resource Settings: https://learn.microsoft.com/en-us/windows/win32/devio/modification-of-communications-resource-settings
- Microsoft, Communications Resource Handles: https://learn.microsoft.com/en-us/windows/win32/devio/communications-resource-handles
- Microsoft, EscapeCommFunction: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-escapecommfunction

These references describe generic behavior, **not** safety certification of a particular adapter or a physical measurement result.
