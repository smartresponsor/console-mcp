import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {inspectVirtualSerial} from "../dist/tool/network-serial-virtual.js";
const req={deviceId:"virtual-serial-fixture",profile:"status-only",baudRate:9600,authorized:true,dtr:false,rts:false};
let opens=0;
const fixture=()=>{opens++;return Readable.from(["model=test password=hunter2 token=abc123\nready\n"]);};
for(const invalid of [{...req,authorized:false},{...req,dtr:true},{...req,rts:true},
  {...req,profile:"configure"},{...req,baudRate:230400},{...req,deviceId:"/dev/ttyUSB0"},
  {...req,command:"show running-config"}])
  assert.equal((await inspectVirtualSerial(invalid,fixture)).status,"SERIAL_REQUEST_DENIED");
assert.equal(opens,0);
assert.equal((await inspectVirtualSerial(req,fixture,{maxBytes:9999})).status,"SERIAL_LIMITS_INVALID");
assert.equal(opens,0);
const ok=await inspectVirtualSerial(req,fixture);
assert.equal(ok.status,"SERIAL_VIRTUAL_READ_OK");
assert.match(ok.output,/password=\[REDACTED\]/);
assert.match(ok.output,/token=\[REDACTED\]/);
assert.doesNotMatch(ok.output,/hunter2|abc123/);
assert.equal((await inspectVirtualSerial(req,()=>Readable.from(["x".repeat(4097)]))).status,"SERIAL_OUTPUT_LIMIT_EXCEEDED");
const controller=new AbortController();
let release;
const held=inspectVirtualSerial(req,()=>Readable.from((async function*(){
  await new Promise(resolve=>{release=resolve;});
  yield "ok";
})()),{signal:controller.signal,timeoutMs:1000});
await new Promise(resolve=>setTimeout(resolve,15));
assert.equal((await inspectVirtualSerial(req,fixture)).status,"SERIAL_DEVICE_BUSY");
controller.abort();
release();
assert.equal((await held).status,"SERIAL_CANCELLED");
assert.equal((await inspectVirtualSerial(req,fixture)).ok,true);
const deadline=await inspectVirtualSerial(req,()=>Readable.from((async function*(){
  await new Promise(resolve=>setTimeout(resolve,50));
  yield "late";
})()),{timeoutMs:5});
assert.equal(deadline.status,"SERIAL_TIMEOUT");
assert.equal((await inspectVirtualSerial(req,fixture)).ok,true);
console.log("NETWORK_VIRTUAL_SERIAL_ACCEPTANCE_PASS");
