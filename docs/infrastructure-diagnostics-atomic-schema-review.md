# Infrastructure Diagnostics — Atomic Tool Schemas and Admission Gates

Status: REVIEW DRAFT. No tools admitted or implemented.
Parent contract: docs/infrastructure-diagnostics-capability-contract-draft.md
Canonical syntax: read_.<domain>.<technology>.<subject>.<action> / write.<...>
Branch at drafting: feature/infrastructure-diagnostics-capabilities

## Shared envelope

Input: `targetId` is an opaque identifier resolved against a locally operator-approved engagement inventory, NEVER a free-form URL/IP/hostname from ChatGPT. No credentials, arbitrary commands, executable arguments or arbitrary file paths. `limit` constrained [1,200], default 50; bounded time windows maximum 24h, defaults 1h; `timeoutMs` [1000,15000]. Explicit `cursor` only for provider-supported stable pagination.

Output schema:
```json
{"ok":true,"status":"complete","targetId":"opaque","vantage":"remote","collectedAt":"RFC3339","technology":"linux","source":"ss","correlationId":"uuid","data":{},"warnings":[],"truncated":false,"nextCursor":null}
```
No sensitive environment variables, unredacted process arguments, authorization tokens, request payloads, or arbitrary journal content. `unsupported`, `permission_denied`, `unreachable`, `timeout`, `partial`, `no_data` are separate statuses; no interpretation of inaccessible as healthy.

## Candidate schema matrix (NOT admitted)

| Canonical candidate | Required + optional parameters | Normalized key fields | Read source / safety |
|---|---|---|---|
| read_.network.ipv4.interface.list | targetId | name, address, prefix, mtu, state | ip -j / Get-NetIPAddress |
| read_.network.ipv4.route.list | targetId, table? enum(main,local,all) | destination, via, interface, metric, table | ip route / Get-NetRoute |
| read_.network.ipv4.neighbor.list | targetId, interface? | address, mac?, state, interface | ip neigh / Get-NetNeighbor |
| read_.network.tcp.listener.list | targetId, port? [1..65535], limit? | localIp, localPort, pid?, processName?, family | ss / Get-NetTCPConnection; privilege-limited PID |
| read_.network.tcp.connection.list | targetId, state? enum, limit? | local, remote, state, pid? | ss / Get-NetTCPConnection |
| read_.network.udp.socket.list | targetId, port?, limit? | local, pid?, processName? | ss / Get-NetUDPEndpoint |
| read_.network.firewall.rule.list | targetId, family? enum(ip,ip6,inet), limit? | source, chain, handle?, expression, counters? | nft / iptables-save / Windows Firewall; do not infer full policy |
| read_.network.firewall.policy.inspect | targetId | backend, chain, hook, defaultPolicy?, verdictUnknown | nft / legacy firewall / Windows |
| read_.network.dns.resolver.inspect | targetId | resolverAddresses, searchDomains, source | resolvectl / system config |
| read_.system.process.list | targetId, sort? enum(cpu,memory,pid), limit? | pid, ppid, state, cpuPercent?, rssBytes?, name | /proc / Get-Process; redact argv/env |
| read_.system.process.detail | targetId, pid > 0 | pid, ppid, state, startTime, cpu?, memory?, threadCount | /proc / Get-Process |
| read_.system.process.fd.list | targetId, pid > 0, limit? | fd, type, sanitizedTarget, total? | /proc; handles vary on Windows; unsupported if absent |
| read_.system.memory.status | targetId | totalBytes, availableBytes, swapBytes, pressure? | /proc / Win32_OperatingSystem |
| read_.system.cpu.load.inspect | targetId | logicalCpus, load1?, load5?, load15?, utilization? | /proc / counters; Linux load != Windows CPU% |
| read_.system.storage.io.status | targetId | devices, readBytes, writeBytes, latency?, sampleInterval? | /proc/diskstats / Windows counters |
| read_.system.service.status | targetId, serviceId | state, subState?, pid?, startType?, errors? | systemctl show / Get-Service |
| read_.system.service.list | targetId, state? enum(active,inactive,failed,all), limit? | serviceId, state, enabled? | systemctl / Get-Service |
| read_.system.journal.record.list | targetId, from, to, limit?, severity?, serviceId? | recordLocator, timestamp, source, severity, sanitizedMessage | journalctl / Get-WinEvent |
| read_.system.journal.record.detail | targetId, recordLocator | timestamp, source, severity, fields, sanitizedMessage | source-scoped opaque locator only |
| read_.system.kernel.oom.record.list | targetId, from, to, limit? | time, killedPid?, process?, reason, source | Linux kernel journal; unsupported for non-equivalent Windows |

## Active diagnostics: defer admission until risk decision

| Candidate | Parameters | Traffic/boundaries |
|---|---|---|
| read_.network.tcp.connection.test | targetId, destinationId, port, timeoutMs | one TCP handshake, allowlisted destination, no payload |
| read_.network.icmp.echo.test | targetId, destinationId, count (1..4) | ICMP, bounded time and rate |
| read_.network.ipv4.route.trace | targetId, destinationId, maxHops (1..16) | probing route, requires explicit authorized target |
| read_.network.dns.record.resolve | targetId, nameId, recordType enum | single bounded resolver query |
| read_.network.tls.certificate.inspect | targetId, destinationId, port | TLS handshake; no request body |

Risk prefix `read_` for active probes is NOT approved until canon review: network traffic is observable external interaction though it does not persistently mutate target. If risk canon disallows, rename under `write.*` with precise semantics rather than claiming passive read.

## Collision & semantics review

- Existing `read_.system.console.*` is Console MCP self-observation, not a client's host metrics; proposed `system.process` and `system.journal` are distinct.
- Existing `read_.http.loopback.*` explicitly forbids external network; do NOT extend its destination range. Active remote HTTP probing would need a separately scoped contract.
- Existing Tailscale tools are product-specific; do not use `tailscale` as a generic network namespace.
- `read_.system.journal.record.detail` must handle Linux cursor/boot-id vs Windows channel/record-id with opaque source-scoped locator and expiry.
- In `read_.network.firewall.rule.list`, listing one host's rules does not prove intermediate ACL/load balancer policy. Evidence should identify observation vantage.
- Network source-to-destination interpretation requires two independent observations. Never conclude filtered solely from timeout.
- A tool name is not itself a safety guarantee: handler, catalog flags, admission and OS permissions must all agree.

## Implementation review gates

1. Inspect dirty local working tree (especially modified canonical-tool-registry.ts) before touching checkout.
2. Finalize each tool's exact input Zod and output schema via reviewed fixtures on Linux and Windows.
3. Validate command templates use argv arrays or platform APIs, not string interpolation into shell.
4. Test caller-controlled targetId cannot cause SSRF, arbitrary SSH destinations, filesystem access, privilege escalation, or cross-engagement access.
5. Limit CPU/IO footprint; process.fd and journal tools require stricter confidentiality masking and rights checks.
6. Add catalog/admission only after explicit approval. No runtime deployment until per-tool ChatGPT smoke tests.
7. Run policy tests, catalog projection snapshot, guarded execution tests and error sanitization tests. Feature branch only.

## Decision log

- ADOPT candidate domain split network/system.
- ADOPT record.list / record.detail terminology.
- REJECT freeform shell and broad scan public tools.
- DEFER active-probe risk classification, access model and exact platform semantics.
- NO implementation, no master checkout changes, no release folder creation.
