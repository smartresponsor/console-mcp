import type { InfraOperation, InfraObservation, InfraPlatform } from "./infrastructure-normalization.js";
import { normalizedObservation, normalizeInfraData } from "./infrastructure-normalization.js";
import { listIpv4Interfaces, listIpv4Neighbors } from "./infrastructure-network-observations.js";
import { inspectIpv4Routes, inspectTcpListeners, inspectProcesses } from "./infrastructure-diagnostics.js";
import { listTcpConnections, inspectCpuLoad, listServices, inspectDiskIo, inspectFirewall } from "./infrastructure-host-observations.js";
import { listUdpSockets, inspectDnsResolver } from "./infrastructure-network-observations.js";
import { inspectMemoryStatus, inspectProcessDetail, inspectServiceStatus, listJournalRecords } from "./infrastructure-system-diagnostics.js";
import { listProcessFds, inspectFirewallPolicy, listOomRecords, inspectJournalRecord } from "./infrastructure-security-observations.js";
import { listWindowsIpv4Interfaces, listWindowsIpv4Routes, inspectWindowsMemory, inspectWindowsCpu, listWindowsServices, inspectWindowsProcess, inspectWindowsService, listWindowsProcesses } from "./infrastructure-windows-observations.js";
import { listWindowsTcpListeners, listWindowsTcpConnections, listWindowsUdpSockets, inspectWindowsDns } from "./infrastructure-windows-network.js";

// Explicit dispatch table, no dynamic command names. Only in-process host OS is supported.
// Not yet imported into production registration.
type Handler = (input: unknown) => Promise<{status:string;source:string;data:Record<string,unknown>;truncated:boolean;warnings:string[]}>;
const linux:Partial<Record<InfraOperation,Handler>>={
 "ipv4.interface.list":listIpv4Interfaces, "ipv4.route.list":inspectIpv4Routes,
 "tcp.listener.list":inspectTcpListeners, "tcp.connection.list":listTcpConnections,
 "udp.socket.list":listUdpSockets, "system.memory.status":inspectMemoryStatus,
 "system.cpu.load.inspect":inspectCpuLoad, "system.service.list":listServices, "system.service.status":inspectServiceStatus, "system.process.detail":inspectProcessDetail, "system.process.list":inspectProcesses, "dns.resolver.inspect":inspectDnsResolver,
 "ipv4.neighbor.list":listIpv4Neighbors, "firewall.policy.inspect":inspectFirewallPolicy,
 "firewall.chain.list":inspectFirewall, "system.storage.io.status":inspectDiskIo,
 "system.journal.record.list":listJournalRecords, "system.journal.record.detail":inspectJournalRecord,
 "system.kernel.oom.record.list":listOomRecords, "system.process.fd.list":listProcessFds,
};
const windows:Partial<Record<InfraOperation,Handler>>={
 "ipv4.interface.list":listWindowsIpv4Interfaces, "ipv4.route.list":listWindowsIpv4Routes,
 "tcp.listener.list":listWindowsTcpListeners, "tcp.connection.list":listWindowsTcpConnections,
 "udp.socket.list":listWindowsUdpSockets, "system.memory.status":inspectWindowsMemory,
 "system.cpu.load.inspect":inspectWindowsCpu, "system.service.list":listWindowsServices, "system.service.status":inspectWindowsService, "system.process.detail":inspectWindowsProcess, "system.process.list":listWindowsProcesses, "dns.resolver.inspect":inspectWindowsDns,
};
export function resolveInfraPlatform(platform:string):InfraPlatform|null{
 if(platform==="linux")return "linux";
 if(platform==="win32")return "windows";
 return null;
}
export async function dispatchLocalInfrastructure(operation:InfraOperation,input:unknown,platform=process.platform):Promise<InfraObservation>{
 const selected=resolveInfraPlatform(platform);
 if(!selected)return normalizedObservation("linux","unsupported host","unsupported",{},false,["host OS unsupported"]);
 // Never let a caller override local target; handlers also parse this value.
 if(!input||typeof input!=="object"||Array.isArray(input)||(input as {targetId?:unknown}).targetId!=="local")
  return normalizedObservation(selected,"input validation","unavailable",{},false,["targetId must be local"]);
 const handler=(selected==="windows"?windows:linux)[operation];
 if(!handler)return normalizedObservation(selected,"operation dispatch","unsupported",{},false,["operation not implemented for host OS"]);
 let raw: Awaited<ReturnType<Handler>>;
 try {
  raw=await handler(input);
 } catch (error) {
  // Validation errors are not retried or converted to successful empty observations.
  // Never echo exception text, because it may contain internal paths or secret values.
  return normalizedObservation(selected,"operation execution","unavailable",{},false,["diagnostic handler failed"]);
 }
 const statuses=new Set(["complete","partial","unavailable","unsupported","permission_denied","timeout","no_data"]);
 const status=statuses.has(raw.status)?raw.status as InfraObservation["status"]:"unavailable";
 return normalizedObservation(selected,raw.source,status,normalizeInfraData(operation,selected,raw.data),raw.truncated,raw.warnings);
}
