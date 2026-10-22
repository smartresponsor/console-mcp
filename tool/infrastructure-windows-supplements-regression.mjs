import assert from "node:assert/strict";
import { normalizeInfraData } from "../dist/tool/infrastructure-normalization.js";
import { windowsNeighborInput, windowsStorageInput, windowsFirewallPolicyInput } from "../dist/tool/infrastructure-windows-supplements.js";
for (const schema of [windowsNeighborInput, windowsStorageInput, windowsFirewallPolicyInput]) {
 assert.deepEqual(schema.parse({targetId:"local"}),{targetId:"local"});
 assert.throws(()=>schema.parse({targetId:"remote"}));
}
assert.deepEqual(normalizeInfraData("ipv4.neighbor.list","windows",{records:[{IPAddress:"192.0.2.1",LinkLayerAddress:"aa-bb",InterfaceAlias:"Ethernet",State:"Reachable"}]}),
 {neighbors:[{address:"192.0.2.1",mac:"aa-bb",interface:"Ethernet",state:"Reachable"}]});
const storage=normalizeInfraData("system.storage.io.status","windows",{records:[{Name:"0 C:",DiskReadsPerSec:20,DiskWritesPerSec:10,DiskReadBytesPerSec:8192,DiskWriteBytesPerSec:4096,Timestamp_PerfTime:123,Frequency_PerfTime:1000}]});
assert.equal(storage.devices[0].counterType,"raw-performance-counter");
assert.equal(storage.devices[0].readBytesCounter,8192);
assert.deepEqual(normalizeInfraData("firewall.policy.inspect","windows",{records:[{Name:"Domain",Enabled:true,DefaultInboundAction:"Block",DefaultOutboundAction:"Allow"}]}),
 {backend:"Windows Defender Firewall",profiles:[{name:"Domain",enabled:true,inboundPolicy:"Block",outboundPolicy:"Allow"}],verdictUnknown:true});
console.log("Windows supplemental normalization fixtures: PASS");
