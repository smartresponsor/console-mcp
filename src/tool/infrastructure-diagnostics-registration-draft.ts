import { dispatchLocalInfrastructure } from "./infrastructure-dispatch-draft.js";
import type { InfraOperation } from "./infrastructure-normalization.js";
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
    description: "List local IPv4 routes; bounded, passive, no target commands.", inputSchema: ipv4RoutesInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("ipv4.route.list" as InfraOperation,input)));
  server.registerTool("read_.network.tcp.listener.list", {
    description: "List local TCP listening endpoints, optionally filtered by port.", inputSchema: tcpListenersInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("tcp.listener.list" as InfraOperation,input)));
  server.registerTool("read_.system.process.list", {
    description: "List bounded local process summary without argv or environment.", inputSchema: processesInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.process.list" as InfraOperation,input)));
  server.registerTool("read_.system.memory.status", {
    description: "Inspect local physical and swap memory counters.", inputSchema: memoryStatusInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.memory.status" as InfraOperation,input)));
  server.registerTool("read_.system.process.detail", {
    description: "Inspect a single local process by numeric PID.", inputSchema: processDetailInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.process.detail" as InfraOperation,input)));
  server.registerTool("read_.system.service.status", {
    description: "Read a constrained local OS service service status without environment values.", inputSchema: serviceStatusInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.service.status" as InfraOperation,input)));
  server.registerTool("read_.system.journal.record.list", {
    description: "List bounded local journal metadata without message content.", inputSchema: journalRecordsInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.journal.record.list" as InfraOperation,input)));
  server.registerTool("read_.network.ipv4.interface.list", {
    description: "List local IPv4 interface configuration.", inputSchema: interfaceInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("ipv4.interface.list" as InfraOperation,input)));
  server.registerTool("read_.network.ipv4.neighbor.list", {
    description: "List local IPv4 neighbor entries; read-only, bounded.", inputSchema: neighborInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("ipv4.neighbor.list" as InfraOperation,input)));
  server.registerTool("read_.network.udp.socket.list", {
    description: "List local UDP endpoints with optional port filter.", inputSchema: udpSocketsInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("udp.socket.list" as InfraOperation,input)));
  server.registerTool("read_.network.dns.resolver.inspect", {
    description: "Inspect local resolver addresses and domains.", inputSchema: dnsResolverInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("dns.resolver.inspect" as InfraOperation,input)));
  server.registerTool("read_.network.tcp.connection.list", {
    description: "List local TCP connections with limited endpoint fields.", inputSchema: tcpConnectionsInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("tcp.connection.list" as InfraOperation,input)));
  server.registerTool("read_.system.cpu.load.inspect", {
    description: "Read local load averages, not CPU utilization percentage.", inputSchema: cpuLoadInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.cpu.load.inspect" as InfraOperation,input)));
  server.registerTool("read_.system.storage.io.status", {
    description: "Read cumulative local disk I/O counters.", inputSchema: diskIoInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.storage.io.status" as InfraOperation,input)));
  server.registerTool("read_.system.service.list", {
    description: "List bounded local OS service service status records.", inputSchema: servicesListInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.service.list" as InfraOperation,input)));
  server.registerTool("read_.network.firewall.chain.list", {
    description: "List local firewall chain names; does not claim rule-level coverage.", inputSchema: firewallInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("firewall.chain.list" as InfraOperation,input)));
  server.registerTool("read_.network.firewall.policy.inspect", {
    description: "Read local firewall base-chain policy metadata, not full effective network policy.", inputSchema: firewallPolicyInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("firewall.policy.inspect" as InfraOperation,input)));
  server.registerTool("read_.system.process.fd.list", {
    description: "List numeric local process file descriptor IDs, not file paths.", inputSchema: fdListInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.process.fd.list" as InfraOperation,input)));
  server.registerTool("read_.system.kernel.oom.record.list", {
    description: "Read bounded local kernel OOM event metadata.", inputSchema: oomRecordsInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.kernel.oom.record.list" as InfraOperation,input)));
  server.registerTool("read_.system.journal.record.detail", {
    description: "Inspect redacted local journal record metadata by constrained cursor.", inputSchema: journalDetailInput, ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.journal.record.detail" as InfraOperation,input)));
}
