import { listWindowsEventRecords, inspectWindowsEventRecord } from "./infrastructure-windows-eventlog.js";
import { listWindowsIpv4Neighbors, inspectWindowsStorageIo, inspectWindowsFirewallPolicy } from "./infrastructure-windows-supplements.js";
import { parseInfrastructureInput } from "./infrastructure-input-contract.js";
import type { InfraOperation, InfraObservation, InfraPlatform } from "./infrastructure-normalization.js";
import { normalizedObservation, normalizeInfraData } from "./infrastructure-normalization.js";
import { finalizeInfrastructureObservation } from "./infrastructure-output-boundary.js";
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
 "ipv4.neighbor.list":listWindowsIpv4Neighbors,
 "system.storage.io.status":inspectWindowsStorageIo,
 "firewall.policy.inspect":inspectWindowsFirewallPolicy,
 "system.journal.record.list":listWindowsEventRecords,
 "system.journal.record.detail":inspectWindowsEventRecord,
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
 let params: Record<string,unknown>;
 try { params=parseInfrastructureInput(operation,input); }
 catch { return normalizedObservation(selected,"input validation","unavailable",{},false,["invalid diagnostic parameters"]); }
 const handler=(selected==="windows"?windows:linux)[operation];
 if(!handler)return normalizedObservation(selected,"operation dispatch","unsupported",{},false,["operation not implemented for host OS"]);
 // Linux systemd accepts only unit identifiers ending with .service.
 // A Windows service identifier is valid in the public contract but not on Linux.
 if(selected==="linux" && operation==="system.service.status" &&
    (typeof params.serviceId!=="string" || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(params.serviceId)))
  return finalizeInfrastructureObservation(normalizedObservation(selected,"service identifier","unsupported",{},false,["service identifier unsupported by systemd adapter"]));
 let raw: Awaited<ReturnType<Handler>>;
 try {
  raw=await handler(params);
 } catch (error) {
  // Validation errors are not retried or converted to successful empty observations.
  // Never echo exception text, because it may contain internal paths or secret values.
  return normalizedObservation(selected,"operation execution","unavailable",{},false,["diagnostic handler failed"]);
 }
 const statuses=new Set(["complete","partial","unavailable","unsupported","permission_denied","timeout","no_data"]);
 const status=statuses.has(raw.status)?raw.status as InfraObservation["status"]:"unavailable";
 // Failed/unavailable observations must not acquire fabricated empty success-shaped records.
 // no_data is distinct: preserve its explicit empty source payload, never normalize it as evidence.
 const normalizedData=(status==="complete"||status==="partial")
  ? normalizeInfraData(operation,selected,raw.data) : {};
 return finalizeInfrastructureObservation(normalizedObservation(selected,raw.source,status,normalizedData,raw.truncated,raw.warnings));
}
