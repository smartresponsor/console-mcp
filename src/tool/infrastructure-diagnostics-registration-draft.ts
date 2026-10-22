import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";
import {
  ipv4RoutesInput, tcpListenersInput, processesInput,
  inspectIpv4Routes, inspectTcpListeners, inspectProcesses,
} from "./infrastructure-diagnostics.js";
import {
  memoryStatusInput, processDetailInput, serviceStatusInput, journalRecordsInput,
  inspectMemoryStatus, inspectProcessDetail, inspectServiceStatus, listJournalRecords,
} from "./infrastructure-system-diagnostics.js";
import {
  interfaceInput, neighborInput, dnsResolverInput, udpSocketsInput,
  listIpv4Interfaces, listIpv4Neighbors, inspectDnsResolver, listUdpSockets,
} from "./infrastructure-network-observations.js";
import {
  firewallInput, tcpConnectionsInput, cpuLoadInput, diskIoInput, servicesListInput,
  inspectFirewall, listTcpConnections, inspectCpuLoad, inspectDiskIo, listServices,
} from "./infrastructure-host-observations.js";
import {
  fdListInput, firewallPolicyInput, oomRecordsInput, journalDetailInput,
  listProcessFds, inspectFirewallPolicy, listOomRecords, inspectJournalRecord,
} from "./infrastructure-security-observations.js";

// Staged registration: NOT imported into src/index.ts, catalog or admission.
// Do not activate before build, permission review, schema conformance and catalog projection.
export function registerInfrastructureDiagnosticsDraft(server: McpServer, authConfig: ConsoleAuthConfig): void {
  const registration = buildConsoleToolRegistration(authConfig);
  server.registerTool("read_.network.ipv4.route.list", {
    description: "List local Linux IPv4 routes; bounded, passive, no target commands.", inputSchema: ipv4RoutesInput, ...registration,
  }, async (input) => textResult(await inspectIpv4Routes(input)));
  server.registerTool("read_.network.tcp.listener.list", {
    description: "List local Linux TCP listening endpoints, optionally filtered by port.", inputSchema: tcpListenersInput, ...registration,
  }, async (input) => textResult(await inspectTcpListeners(input)));
  server.registerTool("read_.system.process.list", {
    description: "List bounded local Linux process summary without argv or environment.", inputSchema: processesInput, ...registration,
  }, async (input) => textResult(await inspectProcesses(input)));
  server.registerTool("read_.system.memory.status", {
    description: "Inspect local Linux physical and swap memory counters.", inputSchema: memoryStatusInput, ...registration,
  }, async (input) => textResult(await inspectMemoryStatus(input)));
  server.registerTool("read_.system.process.detail", {
    description: "Inspect a single local Linux process by numeric PID.", inputSchema: processDetailInput, ...registration,
  }, async (input) => textResult(await inspectProcessDetail(input)));
  server.registerTool("read_.system.service.status", {
    description: "Read a constrained local systemd service status without environment values.", inputSchema: serviceStatusInput, ...registration,
  }, async (input) => textResult(await inspectServiceStatus(input)));
  server.registerTool("read_.system.journal.record.list", {
    description: "List bounded local journal metadata without message content.", inputSchema: journalRecordsInput, ...registration,
  }, async (input) => textResult(await listJournalRecords(input)));
  server.registerTool("read_.network.ipv4.interface.list", {
    description: "List local Linux IPv4 interface configuration.", inputSchema: interfaceInput, ...registration,
  }, async (input) => textResult(await listIpv4Interfaces(input)));
  server.registerTool("read_.network.ipv4.neighbor.list", {
    description: "List local IPv4 neighbor entries; read-only, bounded.", inputSchema: neighborInput, ...registration,
  }, async (input) => textResult(await listIpv4Neighbors(input)));
  server.registerTool("read_.network.udp.socket.list", {
    description: "List local Linux UDP endpoints with optional port filter.", inputSchema: udpSocketsInput, ...registration,
  }, async (input) => textResult(await listUdpSockets(input)));
  server.registerTool("read_.network.dns.resolver.inspect", {
    description: "Inspect local Linux resolver addresses and domains.", inputSchema: dnsResolverInput, ...registration,
  }, async (input) => textResult(await inspectDnsResolver(input)));
  server.registerTool("read_.network.tcp.connection.list", {
    description: "List local Linux TCP connections with limited endpoint fields.", inputSchema: tcpConnectionsInput, ...registration,
  }, async (input) => textResult(await listTcpConnections(input)));
  server.registerTool("read_.system.cpu.load.inspect", {
    description: "Read local Linux load averages, not CPU utilization percentage.", inputSchema: cpuLoadInput, ...registration,
  }, async (input) => textResult(await inspectCpuLoad(input)));
  server.registerTool("read_.system.storage.io.status", {
    description: "Read cumulative local Linux disk I/O counters.", inputSchema: diskIoInput, ...registration,
  }, async (input) => textResult(await inspectDiskIo(input)));
  server.registerTool("read_.system.service.list", {
    description: "List bounded local systemd service status records.", inputSchema: servicesListInput, ...registration,
  }, async (input) => textResult(await listServices(input)));
  server.registerTool("read_.network.firewall.rule.list", {
    description: "List only local nftables chain names; rule disclosure is not implemented.", inputSchema: firewallInput, ...registration,
  }, async (input) => textResult(await inspectFirewall(input)));
  server.registerTool("read_.network.firewall.policy.inspect", {
    description: "Read local nftables base-chain policy metadata, not full effective network policy.", inputSchema: firewallPolicyInput, ...registration,
  }, async (input) => textResult(await inspectFirewallPolicy(input)));
  server.registerTool("read_.system.process.fd.list", {
    description: "List numeric local Linux process file descriptor IDs, not file paths.", inputSchema: fdListInput, ...registration,
  }, async (input) => textResult(await listProcessFds(input)));
  server.registerTool("read_.system.kernel.oom.record.list", {
    description: "Read bounded local Linux kernel OOM event metadata.", inputSchema: oomRecordsInput, ...registration,
  }, async (input) => textResult(await listOomRecords(input)));
  server.registerTool("read_.system.journal.record.detail", {
    description: "Inspect redacted local journal record metadata by constrained cursor.", inputSchema: journalDetailInput, ...registration,
  }, async (input) => textResult(await inspectJournalRecord(input)));
}
