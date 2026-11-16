import assert from "node:assert/strict";
import { captureMockSerialHandle } from "../dist/tool/network-serial-mock-handle-lifecycle.js";
import { OfflineSerialLeaseCoordinator } from "../dist/tool/network-serial-session-lease.js";

const target={id:"bench",platform:"linux",device:"/dev/ttyUSB0",profile:"status-only",
  baudRate:9600,dtr:false,rts:false};
const request={targetId:"bench",observation:"capture"};
const approval={...request,approved:true};
const witness={platform:"linux",device:"/dev/ttyUSB0",
  instanceId:"/sys/devices/pci0000:00/usb1",identity:"188:0",
  dtr:false,rts:false,verified:true};
const enc=s=>new TextEncoder().encode(s);
const lease=new OfflineSerialLeaseCoordinator();
const run=(factory,opts={timeoutMs:500})=>
  captureMockSerialHandle(request,[target],approval,"linux",lease,factory,opts);

// Stream fragmentation must not bypass secret redaction.
let closed=0;
let r=await run(async()=>{
  const handle={};return {
    handle,observe:async()=>({handle,witness,modemLinesSafe:false}),
    frames:(async function*(){
      yield enc("tok");yield enc("en=fra");yield enc("gmented-secret\nready");
    })(),
    close:async()=>{closed++;},
  };
});
assert.equal(r.ok,true);
assert.equal(r.value.output.includes("fragmented-secret"),false);
assert.match(r.value.output,/token=\[REDACTED\]/);
assert.equal(closed,1);
assert.equal(lease.isLeased("bench"),false);

// Cancellation must not release lease while streaming or close() is pending.
let frameEntered;const frameReady=new Promise(resolve=>{frameEntered=resolve;});
let releaseFrame;
const frameHold=new Promise(resolve=>{releaseFrame=resolve;});
let closeEntered;const closeReady=new Promise(resolve=>{closeEntered=resolve;});
let releaseClose;
const closeHold=new Promise(resolve=>{releaseClose=resolve;});
let closeCalls=0;
const controller=new AbortController();
const pending=run(async()=>{
  const handle={};return {
    handle,observe:async()=>({handle,witness,modemLinesSafe:false}),
    frames:(async function*(){
      frameEntered();await frameHold;yield enc("token=late");
    })(),
    close:async()=>{
      closeCalls++;closeEntered();await closeHold;
    },
  };
},{timeoutMs:500,signal:controller.signal});
await frameReady;
controller.abort();
r=await pending;
assert.equal(r.ok,false);
assert.equal(r.status,"SERIAL_LEASE_CANCELLED");
assert.equal(lease.isLeased("bench"),true);
const never=async()=>{throw Error("SECOND_SESSION_MUST_NOT_START");};
let busy=await run(never);
assert.equal(busy.status,"SERIAL_LEASE_BUSY");
releaseFrame();
await closeReady;
assert.equal(lease.isLeased("bench"),true);
busy=await run(never);
assert.equal(busy.status,"SERIAL_LEASE_BUSY");
releaseClose();
for(let i=0;i<100&&lease.isLeased("bench");i++)
  await new Promise(resolve=>setTimeout(resolve,5));
assert.equal(closeCalls,1);
assert.equal(lease.isLeased("bench"),false);
// A new mock session is now admitted; no OS handle is acquired.
r=await run(async()=>{
  const handle={};return {
    handle,observe:async()=>({handle,witness,modemLinesSafe:false}),
    frames:(async function*(){yield enc("ready");})(),
    close:async()=>{closed++;},
  };
});
assert.equal(r.ok,true);
assert.equal(r.value.mayOpenDevice,false);
assert.equal(closed,2);
console.log("NETWORK_SERIAL_MOCK_HANDLE_CANCEL_CLEANUP_PASS");
