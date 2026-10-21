# Infrastructure Diagnostics — Capability Contract Draft

Status: PROPOSED — not admitted, not implemented
Branch: feature/infrastructure-diagnostics-capabilities
Source of truth: docs/tool-naming-canon.md, docs/tool-risk-model.md, src/engine/tool-admission.ts
Scope: personal portable troubleshooting from ChatGPT via Console MCP.
No target-side MCP agents, no parallel release folders, no runtime switch.

## Canonical principles

- Public name: `<risk>.<domain>.<technology>.<subject>.<action>`, risk exactly `read_` or `write`.
- One observable, bounded action per tool. No free-form shell, PowerShell, script, Nmap flags, generic command string, batch plan, or model-defined pipelines.
- `read_` means no persistent target-state mutation; active probes must be distinguished in metadata and bounded by target/session policy.
- Consumer admission: each new tool explicitly `kind=atomic`, `consumers=[chatgpt]` only after schema and guard validation; add other consumers deliberately.
- Results must contain target_id, collected_at, observer vantage (laptop/remote), source/technology, evidence, truncation, warnings, and correlation_id. Unknown/inaccessible is not zero/healthy.
- Credentials never appear as MCP tool parameters, tool output, or log content.
- Client authorization is independent of ChatGPT's own refusal/confirmation layer.

## Proposed read capabilities — review required before admission

| Candidate | Operation | Minimum input | Backend |
| --- | --- | --- | --- |
| `read_.network.ipv4.interface.list` | IPv4 interface addresses/status | target_id | ip/PowerShell |
| `read_.network.ipv4.route.list` | IPv4 route table and metrics | target_id | ip route/PowerShell |
| `read_.network.ipv4.neighbor.list` | Neighbor/ARP state | target_id | ip neigh/PowerShell |
| `read_.network.tcp.listener.list` | Listening TCP sockets | target_id, optional port, limit | ss/Get-NetTCPConnection |
| `read_.network.tcp.connection.list` | TCP connection state | target_id, optional state, limit | ss/Get-NetTCPConnection |
| `read_.network.udp.socket.list` | UDP bound sockets | target_id, optional port, limit | ss/Get-NetUDPEndpoint |
| `read_.network.firewall.rule.list` | Firewall rules, no modification | target_id, optional family/table, limit | nft/iptables/Windows Firewall |
| `read_.network.firewall.policy.inspect` | Default chain policies | target_id | nft/iptables/Windows Firewall |
| `read_.network.dns.resolver.inspect` | Resolver configuration | target_id | OS-specific read |
| `read_.system.process.list` | PID/PPID/CPU/RSS state | target_id, sort, limit | /proc/ps/Get-Process |
| `read_.system.process.detail` | One process | target_id, pid | /proc/Get-Process |
| `read_.system.process.fd.list` | File descriptors/handles | target_id, pid, limit | /proc/approved OS tool |
| `read_.system.memory.status` | RAM/swap/cgroup usage | target_id | proc/PowerShell |
| `read_.system.cpu.load.inspect` | Load and saturation indicators | target_id | proc/PowerShell |
| `read_.system.storage.io.status` | Disk I/O and latency indicators | target_id | OS-specific |
| `read_.system.service.status` | One service state | target_id, service_id | systemd/Windows Services |
| `read_.system.service.list` | Services by state | target_id, optional state, limit | systemd/Windows Services |
| `read_.system.journal.record.list` | Time-bounded journal records | target_id, from, to, limit, filters | journalctl/Event Log |
| `read_.system.journal.record.detail` | One journal record, where supported | target_id, record_id | journalctl/Event Log |
| `read_.system.kernel.oom.record.list` | OOM events | target_id, from, to, limit | journalctl/Event Log |

Note: Windows Event Logs and Linux journal do not necessarily share stable record identifiers; detail contract needs a source-scoped locator and platform validation.

## Active diagnostics: candidate names and classification to resolve

- `read_.network.tcp.connection.test`: single target host+port TCP connect, bounded timeout and source vantage.
- `read_.network.icmp.echo.test`: bounded ICMP echo count/rate.
- `read_.network.ipv4.route.trace`: bounded traceroute with explicit max hops and traffic budget.
- `read_.network.dns.record.resolve`: bounded DNS resolution.
- `read_.network.tls.certificate.inspect`: bounded TLS handshake and certificate metadata.

These create traffic. `read_` classification must be justified under existing risk canon, with activeProbe=true, allowlisted destinations, rate limits, no broad scan, and recorded consent. If canon considers such side effects disqualifying, introduce explicit `write.*` equivalents rather than mislabeling.

## Out of v1 public MCP exposure

- Arbitrary shell/PowerShell/script and user-supplied executable flags.
- Nmap network sweeps, NSE scripting, passive sniffing without separately reviewed permissions.
- Bulk service restart, firewall alteration, process kill, firmware/power mutation.
- Arbitrary remote HTTP requests and SSH tunnels.
- One-click composite incident repair or silent escalation of diagnostics into maintenance.

## Operational controls

1. Per-client session: operator, client engagement ID, target allowlist (IPs/host IDs), expiry, permitted observation vantage, allowed capabilities.
2. Local executor only, without target-installed agents; SSH/WinRM/APIs/OS tools remain internal.
3. Read-only accounts where possible; command-level least privilege and strict host-key/TLS validation.
4. Limit per-target concurrency, maximum response bytes and rows, time range, command runtime, active probe frequency, and log sensitivity.
5. Structured errors distinguishing unreachable, permission_denied, unsupported, timeout, incomplete, and no_data.
6. No automatic prompt/tool escalation; separate operator authorization for any `write.*`.
7. Runtime and current master checkout remain untouched; no new release directories.

## Next acceptance gates (not yet performed)

- Diff candidate names against complete canonical admission catalog and existing implementation; remove collisions and duplicates.
- Inspect Windows working-tree changes, especially canonical-tool-registry.ts, before local development.
- Verify Linux/Windows-specific backend capability and privilege requirements.
- Add policy/catalog/admission declarations and Zod schemas only after names are approved.
- Unit and mock tests for command templates, input constraints, output normalization, permissions and failure modes.
- Real ChatGPT connector smoke tests for each atomic tool and refusal/approval behavior in a non-production lab.
- Merge only through reviewed integration and rollback procedure.
