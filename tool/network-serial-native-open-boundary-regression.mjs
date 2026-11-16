import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planSerialCapture } from "../dist/tool/network-serial-admission.js";
import { OfflineSerialLeaseCoordinator } from "../dist/tool/network-serial-session-lease.js";
import { captureOfflineSerialFixture } from "../dist/tool/network-serial-offline-capture.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const networkSources = readdirSync(path.join(root,"src/tool"))
  .filter(name => /^(?:network-serial-|network-windows-serial)/.test(name) && name.endsWith(".ts"));
assert.ok(networkSources.includes("network-serial-offline-capture.ts"));
// This is an explicit *temporary* architecture gate: introducing a native
// serial transport requires security review and a replacement for this test.
// It is not an OS-enforced guarantee against side-effects in other modules.
for(const filename of networkSources) {
  const code=readFileSync(path.join(root,"src/tool",filename),"utf8");
  if(filename === "network-windows-serial.ts") continue; // passive CIM inventory subprocess
  assert.doesNotMatch(code,/\b(?:CreateFileW?|SetCommState|EscapeCommFunction|TIOCMBIS|TIOCMBIC|TIOCMSET|TIOCMGET)\s*\(/);
  assert.doesNotMatch(code,/\b(?:from\s*["\x27]|require\s*\(\s*["\x27])(?:@serialport\/|serialport["\x27])/i);
  assert.doesNotMatch(code,/\b(?:openSync|createReadStream|createWriteStream)\s*\(/);
}
const linux={id:"offline_l",platform:"linux",device:"/dev/ttyUSB0",profile:"status-only",baudRate:9600,dtr:false,rts:false};
const windows={...linux,id:"offline_w",platform:"win32",device:"COM7"};
for(const target of [linux,windows]){
  const req={targetId:target.id,observation:"capture"};
  const approval={targetId:target.id,observation:"capture",approved:true};
  const p=planSerialCapture(req,[target],approval,target.platform);
  assert.equal(p.ok,true);
  assert.equal(p.mayOpenDevice,false);
  assert.equal(p.requiresOsDeviceVerification,true);
  assert.equal(Object.hasOwn(p,"device"),false);
  let calls=0;
  // No device/open factory is ever invoked with untrusted extended request.
  const r=await captureOfflineSerialFixture({...req,device:target.device,physical:true,modemSafety:"verified"},
    [target],approval,target.platform,new OfflineSerialLeaseCoordinator(),async()=>{
      calls++;throw Error("MUST_NEVER_OPEN");
    },{timeoutMs:100});
  assert.equal(r.ok,false);
  assert.equal(r.status,"SERIAL_OFFLINE_ADMISSION_DENIED");
  assert.equal(calls,0);
}
console.log("NETWORK_SERIAL_NATIVE_OPEN_BOUNDARY_PASS",networkSources.length);
