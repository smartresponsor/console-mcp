import assert from "node:assert/strict";
import {normalizeInfraData,normalizedObservation} from "../dist/tool/infrastructure-normalization.js";
import {resolveInfraPlatform} from "../dist/tool/infrastructure-dispatch-draft.js";

assert.equal(resolveInfraPlatform("linux"),"linux");
assert.equal(resolveInfraPlatform("win32"),"windows");
assert.equal(resolveInfraPlatform("darwin"),null);
assert.deepEqual(normalizeInfraData("ipv4.route.list","linux",{
 routes:[{destination:"default",gateway:"192.0.2.1",interface:"eth0",metric:10}]
}),{routes:[{destination:"default",gateway:"192.0.2.1",interface:"eth0",metric:10}]});
assert.deepEqual(normalizeInfraData("ipv4.route.list","windows",{
 records:[{DestinationPrefix:"0.0.0.0/0",NextHop:"192.0.2.1",InterfaceAlias:"Ethernet",RouteMetric:25}]
}),{routes:[{destination:"0.0.0.0/0",gateway:"192.0.2.1",interface:"Ethernet",metric:25}]});
assert.deepEqual(normalizeInfraData("system.memory.status","linux",{bytes:{MemTotal:1048576,MemAvailable:524288,SwapTotal:0,SwapFree:0}}),
 {totalBytes:1048576,availableBytes:524288,swapTotalBytes:0,swapFreeBytes:0});
assert.deepEqual(normalizeInfraData("system.memory.status","windows",{records:[{TotalVisibleMemorySize:1024,FreePhysicalMemory:512}]}),
 {totalBytes:1048576,availableBytes:524288,swapTotalBytes:null,swapFreeBytes:null});
assert.deepEqual(normalizeInfraData("tcp.listener.list","windows",{
 sockets:[{LocalAddress:"0.0.0.0",LocalPort:443,State:"Listen",OwningProcess:123}]
}),{listeners:[{localAddress:"0.0.0.0",localPort:443,state:"Listen",pid:123}]});
const unsupported=normalizedObservation("linux","unsupported host","unsupported",{});
assert.equal(unsupported.ok,false);
assert.equal(unsupported.status,"unsupported");
assert.equal(unsupported.targetId,"local");
console.log("cross-platform normalization fixture contracts: PASS");
