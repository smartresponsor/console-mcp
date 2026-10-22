// Platform-independent response contract for draft Infrastructure Diagnostics.
// No executable commands, registry side effects, or MCP registration.
export type InfraStatus = "complete" | "partial" | "unavailable" | "unsupported" | "permission_denied" | "timeout" | "no_data";
export type InfraPlatform = "linux" | "windows";
export type InfraRecord = Record<string, unknown>;
export type InfraObservation = {
  ok: boolean; status: InfraStatus; targetId: "local"; vantage: "local";
  technology: InfraPlatform; source: string; collectedAt: string;
  data: InfraRecord; warnings: string[]; truncated: boolean;
};
export function normalizedObservation(platform: InfraPlatform, source: string, status: InfraStatus, data: InfraRecord, truncated=false, warnings: string[]=[]): InfraObservation {
  return { ok: status==="complete" || status==="partial", status, targetId:"local", vantage:"local",
    technology:platform, source, collectedAt:new Date().toISOString(), data, warnings, truncated };
}
const record = (v:unknown):InfraRecord|null => v !== null && typeof v==="object" && !Array.isArray(v) ? v as InfraRecord : null;
const rows = (v:unknown):InfraRecord[] => Array.isArray(v) ? v.map(record).filter((v):v is InfraRecord=>v!==null) : [];
const str=(v:unknown):string|null=>typeof v==="string"?v:null;
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
export type InfraOperation = "ipv4.interface.list"|"ipv4.route.list"|"tcp.listener.list"|"tcp.connection.list"|"udp.socket.list"|"system.memory.status"|"system.cpu.load.inspect"|"system.service.list"|"system.service.status"|"system.process.detail"|"system.process.list"|"dns.resolver.inspect"|"ipv4.neighbor.list"|"firewall.policy.inspect"|"firewall.chain.list"|"system.storage.io.status"|"system.journal.record.list"|"system.journal.record.detail"|"system.kernel.oom.record.list"|"system.process.fd.list";
export function normalizeInfraData(operation:InfraOperation, platform:InfraPlatform, input:InfraRecord):InfraRecord {
  switch(operation){
    case "ipv4.interface.list": {
      const items=platform==="linux"?rows(input.interfaces):rows(input.records);
      return {interfaces:items.map(v=>platform==="linux"?
        {name:str(v.name),state:str(v.state),mtu:num(v.mtu),addresses:rows(v.addresses).map(a=>({address:str(a.address),prefixLength:num(a.prefixLength)}))}:
        {name:str(v.InterfaceAlias),state:str(v.AddressState),mtu:null,addresses:[{address:str(v.IPAddress),prefixLength:num(v.PrefixLength)}]})};
    }
    case "ipv4.route.list": {
      const items=platform==="linux"?rows(input.routes):rows(input.records);
      return {routes:items.map(v=>platform==="linux"?
        {destination:str(v.destination),gateway:str(v.gateway),interface:str(v.interface),metric:num(v.metric)}:
        {destination:str(v.DestinationPrefix),gateway:str(v.NextHop),interface:str(v.InterfaceAlias),metric:num(v.RouteMetric)})};
    }
    case "tcp.listener.list": {
      const items=platform==="linux"?rows(input.listeners):rows(input.sockets);
      return {listeners:items.map(v=>platform==="linux"?
        {localAddress:str(v.address),localPort:num(v.port),state:str(v.state),pid:null}:
        {localAddress:str(v.LocalAddress),localPort:num(v.LocalPort),state:str(v.State),pid:num(v.OwningProcess)})};
    }
    case "tcp.connection.list": {
      const items=platform==="linux"?rows(input.connections):rows(input.sockets);
      return {connections:items.map(v=>platform==="linux"?
        {localAddress:str(v.localAddress),localPort:num(v.localPort),remoteAddress:str(v.remoteAddress),remotePort:num(v.remotePort),state:str(v.state),pid:null}:
        {localAddress:str(v.LocalAddress),localPort:num(v.LocalPort),remoteAddress:str(v.RemoteAddress),remotePort:num(v.RemotePort),state:str(v.State),pid:num(v.OwningProcess)})};
    }
    case "udp.socket.list": {
      const items=platform==="linux"?rows(input.sockets):rows(input.sockets);
      return {sockets:items.map(v=>platform==="linux"?
        {localAddress:str(v.address),localPort:num(v.port),pid:null}:
        {localAddress:str(v.LocalAddress),localPort:num(v.LocalPort),pid:num(v.OwningProcess)})};
    }
    case "system.memory.status": {
      if(platform==="linux"){
        const bytes=record(input.bytes)??{};
        return {totalBytes:num(bytes.MemTotal),availableBytes:num(bytes.MemAvailable),swapTotalBytes:num(bytes.SwapTotal),swapFreeBytes:num(bytes.SwapFree)};
      }
      const v=rows(input.records)[0]??{};
      const kb=(x:unknown)=>num(x)===null?null:num(x)!*1024;
      return {totalBytes:kb(v.TotalVisibleMemorySize),availableBytes:kb(v.FreePhysicalMemory),swapTotalBytes:null,swapFreeBytes:null};
    }
    case "system.cpu.load.inspect": {
      if(platform==="linux"){const v=record(input.load)??{};return {load1:num(v.load1),load5:num(v.load5),load15:num(v.load15),utilizationPercent:null};}
      const cpus=rows(input.records);
      return {load1:null,load5:null,load15:null,utilizationPercent:cpus.length?cpus.reduce((n,v)=>n+(num(v.LoadPercentage)??0),0)/cpus.length:null};
    }
    case "dns.resolver.inspect": {
      if(platform==="linux"){const v=record(input.resolver)??{};return {resolverAddresses:Array.isArray(v.servers)?v.servers.filter(x=>typeof x==="string"):[],searchDomains:Array.isArray(v.domains)?v.domains.filter(x=>typeof x==="string"):[]};}
      const addresses=rows(input.interfaces).flatMap(v=>Array.isArray(v.ServerAddresses)?v.ServerAddresses.filter(x=>typeof x==="string"):[]);
      return {resolverAddresses:[...new Set(addresses)],searchDomains:[]};
    }
    case "system.service.status": {
      const v=platform==="linux"?(record(input.service)??{}):(record(input.service)??{});
      return platform==="linux"?{id:str(v.Id),state:str(v.ActiveState),subState:str(v.SubState),pid:num(v.MainPID),startType:str(v.UnitFileState)}:
        {id:str(v.Name),state:v.Status===null?null:String(v.Status??""),subState:null,pid:null,startType:v.StartType===null?null:String(v.StartType??"")};
    }
    case "system.process.detail": {
      const v=record(input.process)??{};
      return platform==="linux"?{pid:num(v.pid),ppid:num(v.ppid),name:str(v.name),state:str(v.state),rssBytes:num(v.rssBytes)}:
        {pid:num(v.ProcessId),ppid:num(v.ParentProcessId),name:str(v.Name),state:null,rssBytes:num(v.WorkingSetSize)};
    }
    case "system.process.list": {
      const items=platform==="linux"?rows(input.processes):rows(input.records);
      return {processes:items.map(v=>platform==="linux"?{pid:num(v.pid),ppid:num(v.ppid),name:str(v.name),rssBytes:num(v.rssBytes)}:
        {pid:num(v.ProcessId),ppid:num(v.ParentProcessId),name:str(v.Name),rssBytes:num(v.WorkingSetSize)})};
    }

    case "ipv4.neighbor.list":
      return {neighbors:rows(input.neighbors).map(v=>({address:str(v.address),mac:str(v.mac),interface:str(v.interface),state:str(v.state)}))};
    case "firewall.policy.inspect":
      return {backend:str(input.backend),baseChains:rows(input.baseChains).map(v=>({chain:str(v.chain),hook:str(v.hook),priority:str(v.priority),policy:str(v.policy)})),verdictUnknown:true};
    case "firewall.chain.list":
      return {chainNames:Array.isArray(input.chains)?input.chains.filter(v=>typeof v==="string").slice(0,100):[],ruleCoverage:false};
    case "system.storage.io.status":
      return {devices:rows(input.disks).map(v=>({device:str(v.device),readsCompleted:num(v.readsCompleted),sectorsRead:num(v.sectorsRead),writesCompleted:num(v.writesCompleted),sectorsWritten:num(v.sectorsWritten),ioMilliseconds:num(v.ioMilliseconds),counterType:"cumulative"}))};
    case "system.journal.record.list":
      return {records:rows(input.records).map(v=>({cursor:str(v.cursor),timestampUsec:str(v.timestampUsec),priority:str(v.priority),unit:str(v.unit)}))};
    case "system.journal.record.detail": {
      const v=record(input.record)??{};
      return {record:{timestampUsec:str(v.timestamp),priority:str(v.severity),unit:str(v.unit),messageRedacted:true}};
    }
    case "system.kernel.oom.record.list":
      return {records:rows(input.records).map(v=>({timestampUsec:str(v.timestamp),event:str(v.event)}))};
    case "system.process.fd.list":
      return {fdNumbers:Array.isArray(input.fdNumbers)?input.fdNumbers.filter(v=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0).slice(0,100):[],observedCount:num(input.observedCount)};
    case "system.service.list": {
      const items=platform==="linux"?rows(input.services):rows(input.services);
      return {services:items.map(v=>platform==="linux"?
        {id:str(v.unit),state:str(v.active),subState:str(v.sub),startType:null}:
        {id:str(v.Name),state:str(v.Status),subState:null,startType:str(v.StartType)})};
    }
  }
}
