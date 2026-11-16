import assert from "node:assert/strict";
import { captureMockSerialHandle } from "../dist/tool/network-serial-mock-handle-lifecycle.js";
import { OfflineSerialLeaseCoordinator } from "../dist/tool/network-serial-session-lease.js";
const target=Object.freeze({id:"bench",platform:"linux",device:"/dev/ttyUSB0",profile:"status-only",
  baudRate:9600,dtr:false,rts:false});
const request={targetId:"bench",observation:"capture"};
const approval={...request,approved:true};
const witness={platform:"linux",device:"/dev/ttyUSB0",instanceId:"/sys/devices/pci0000:00/usb1",
  identity:"188:0",dtr:false,rts:false,verified:true};
const enc=s=>new TextEncoder().encode(s);
const leases=new OfflineSerialLeaseCoordinator();
let events=[];
const fixture=(opts={})=>async()=>{
  const handle={kind:"mock"};let observed=0;
  return {
    handle,
    observe:async()=>{
      events.push("observe"+(++observed));
      return {handle:observed===2&&opts.swapHandle?{}:handle,
        witness:observed===2&&opts.drift?{...witness,identity:"188:1"}:witness,
        modemLinesSafe:opts.claimPhysicalSafety===true};
    },
    frames:(async function*(){events.push("frame");yield opts.huge?new Uint8Array(1025):enc("token=abc123\nready");})(),
    close:async()=>{events.push("close");if(opts.closeFails)throw Error("secret=never-show");},
  };
};
const run=(f,req=request)=>captureMockSerialHandle(req,[target],approval,"linux",leases,f,{timeoutMs:500});
let r=await run(fixture());
assert.equal(r.ok,true);
assert.equal(r.value.mayOpenDevice,false);
assert.equal(r.value.output.includes("abc123"),false);
assert.equal(r.value.output.includes("[REDACTED]"),true);
assert.deepEqual(events,["observe1","frame","observe2","close"]);
for(const [name,opts] of [
  ["drift",{drift:true}],["swapped-handle",{swapHandle:true}],
  ["unsafe-claim",{claimPhysicalSafety:true}],["oversize-frame",{huge:true}],
  ["close-error",{closeFails:true}],
]){
  events=[];r=await run(fixture(opts));
  assert.equal(r.ok,false,name);
  assert.equal(r.status,"SERIAL_LEASE_TASK_FAILED",name);
  assert.equal(events.at(-1),"close",name);
  assert.equal(leases.isLeased("bench"),false,name);
}
let called=false;
r=await run(async()=>{called=true;throw Error("should not run");},{...request,device:"/dev/ttyUSB0"});
assert.equal(r.status,"SERIAL_MOCK_ADMISSION_DENIED");
assert.equal(called,false);
// Timed-out mock must retain lease while its delayed frame/cleanup is pending.
let release;let closeCount=0;
const pending=captureMockSerialHandle(request,[target],approval,"linux",leases,async()=>{
  const handle={};return {
    handle,observe:async()=>({handle,witness,modemLinesSafe:false}),
    frames:(async function*(){await new Promise(resolve=>{release=resolve;});yield enc("late");})(),
    close:async()=>{closeCount++;},
  };
},{timeoutMs:30});
await new Promise(resolve=>setTimeout(resolve,45));
r=await pending;
assert.equal(r.status,"SERIAL_LEASE_TIMEOUT");
assert.equal(leases.isLeased("bench"),true);
const blocked=await run(fixture());
assert.equal(blocked.status,"SERIAL_LEASE_BUSY");
release();
for(let i=0;i<40&&leases.isLeased("bench");i++)await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(closeCount,1);
assert.equal(leases.isLeased("bench"),false);
console.log("NETWORK_SERIAL_MOCK_HANDLE_LIFECYCLE_PASS");
