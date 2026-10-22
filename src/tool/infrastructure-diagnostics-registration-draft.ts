import { infraInputSchemas } from "./infrastructure-input-contract.js";
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
    description: "List local IPv4 routes; bounded, passive, no target commands.", inputSchema: infraInputSchemas["ipv4.route.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("ipv4.route.list" as InfraOperation,input)));
  server.registerTool("read_.network.tcp.listener.list", {
    description: "List local TCP listening endpoints, optionally filtered by port.", inputSchema: infraInputSchemas["tcp.listener.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("tcp.listener.list" as InfraOperation,input)));
  server.registerTool("read_.system.process.list", {
    description: "List bounded local process summary without argv or environment.", inputSchema: infraInputSchemas["system.process.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.process.list" as InfraOperation,input)));
  server.registerTool("read_.system.memory.status", {
    description: "Inspect local physical and swap memory counters.", inputSchema: infraInputSchemas["system.memory.status"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.memory.status" as InfraOperation,input)));
  server.registerTool("read_.system.process.detail", {
    description: "Inspect a single local process by numeric PID.", inputSchema: infraInputSchemas["system.process.detail"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.process.detail" as InfraOperation,input)));
  server.registerTool("read_.system.service.status", {
    description: "Read a constrained local OS service service status without environment values.", inputSchema: infraInputSchemas["system.service.status"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.service.status" as InfraOperation,input)));
  server.registerTool("read_.system.journal.record.list", {
    description: "List bounded local journal metadata without message content.", inputSchema: infraInputSchemas["system.journal.record.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.journal.record.list" as InfraOperation,input)));
  server.registerTool("read_.network.ipv4.interface.list", {
    description: "List local IPv4 interface configuration.", inputSchema: infraInputSchemas["ipv4.interface.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("ipv4.interface.list" as InfraOperation,input)));
  server.registerTool("read_.network.ipv4.neighbor.list", {
    description: "List local IPv4 neighbor entries; read-only, bounded.", inputSchema: infraInputSchemas["ipv4.neighbor.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("ipv4.neighbor.list" as InfraOperation,input)));
  server.registerTool("read_.network.udp.socket.list", {
    description: "List local UDP endpoints with optional port filter.", inputSchema: infraInputSchemas["udp.socket.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("udp.socket.list" as InfraOperation,input)));
  server.registerTool("read_.network.dns.resolver.inspect", {
    description: "Inspect local resolver addresses and domains.", inputSchema: infraInputSchemas["dns.resolver.inspect"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("dns.resolver.inspect" as InfraOperation,input)));
  server.registerTool("read_.network.tcp.connection.list", {
    description: "List local TCP connections with limited endpoint fields.", inputSchema: infraInputSchemas["tcp.connection.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("tcp.connection.list" as InfraOperation,input)));
  server.registerTool("read_.system.cpu.load.inspect", {
    description: "Read local load averages, not CPU utilization percentage.", inputSchema: infraInputSchemas["system.cpu.load.inspect"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.cpu.load.inspect" as InfraOperation,input)));
  server.registerTool("read_.system.storage.io.status", {
    description: "Read cumulative local disk I/O counters.", inputSchema: infraInputSchemas["system.storage.io.status"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.storage.io.status" as InfraOperation,input)));
  server.registerTool("read_.system.service.list", {
    description: "List bounded local OS service service status records.", inputSchema: infraInputSchemas["system.service.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.service.list" as InfraOperation,input)));
  server.registerTool("read_.network.firewall.chain.list", {
    description: "List local firewall chain names; does not claim rule-level coverage.", inputSchema: infraInputSchemas["firewall.chain.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("firewall.chain.list" as InfraOperation,input)));
  server.registerTool("read_.network.firewall.policy.inspect", {
    description: "Read local firewall base-chain policy metadata, not full effective network policy.", inputSchema: infraInputSchemas["firewall.policy.inspect"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("firewall.policy.inspect" as InfraOperation,input)));
  server.registerTool("read_.system.process.fd.list", {
    description: "List numeric local process file descriptor IDs, not file paths.", inputSchema: infraInputSchemas["system.process.fd.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.process.fd.list" as InfraOperation,input)));
  server.registerTool("read_.system.kernel.oom.record.list", {
    description: "Read bounded local kernel OOM event metadata.", inputSchema: infraInputSchemas["system.kernel.oom.record.list"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.kernel.oom.record.list" as InfraOperation,input)));
  server.registerTool("read_.system.journal.record.detail", {
    description: "Inspect redacted local journal record metadata by constrained cursor.", inputSchema: infraInputSchemas["system.journal.record.detail"], ...registration,
  }, async (input) => textResult(await dispatchLocalInfrastructure("system.journal.record.detail" as InfraOperation,input)));
}
