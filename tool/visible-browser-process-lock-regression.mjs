import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, chmodSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { acquireVisibleProcessLease, runWithHeldVisibleProcessLease, withVisibleProcessLease } from "../dist/service/visible-browser-process-lock.js";
import { withDirectBrowserOperationLease } from "../dist/service/direct-browser-operation-lease.js";

const key = JSON.stringify(["http://127.0.0.1:9223", "/devtools/browser/fixture"]);
const a = "a".repeat(32), b = "b".repeat(32);
if (process.platform !== "linux") {
  assert.equal((await acquireVisibleProcessLease(key, "browser", null)).ok, false);
  console.log("visible process lock: non-Linux fail-closed PASS");
  process.exit(0);
}
if (process.argv.includes("--holder")) {
  const lease = await acquireVisibleProcessLease(key, "browser", null);
  if (!lease.ok) process.exit(2);
  console.log("HELD");
  process.stdin.resume();
  await once(process.stdin, "end");
  await lease.release();
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), "visible-process-lock-"));
const original = process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
let child;
const held = [];
const acquire = async (...args) => {
  const lease = await acquireVisibleProcessLease(...args);
  if (lease.ok) held.push(lease);
  return lease;
};
try {
  delete process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
  assert.equal((await acquire(key, "browser", null)).reason, "CROSS_PROCESS_LEASE_UNAVAILABLE");
  process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = root;
  const t1 = await acquire(key, "target", a);
  const t2 = await acquire(key, "target", b);
  assert.equal(t1.ok, true); assert.equal(t2.ok, true);
  assert.equal((await acquire(key, "target", a)).reason, "CROSS_PROCESS_LEASE_BUSY");
  assert.equal((await acquire(key, "browser", null)).reason, "CROSS_PROCESS_LEASE_BUSY");
  await t1.release(); await t2.release();
  child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--holder"],
    { env: { ...process.env }, stdio: ["pipe","pipe","inherit"] });
  const childExit = once(child, "exit");
  let text = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("holder readiness timeout")), 6000);
    child.stdout.on("data", data => {
      text += data;
      if (text.includes("HELD\n")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(Error("holder exited before readiness")); });
  });
  assert.equal((await acquire(key, "browser", null)).reason, "CROSS_PROCESS_LEASE_BUSY");
  assert.equal((await acquire(key, "target", b)).reason, "CROSS_PROCESS_LEASE_BUSY");
  const other = await acquire(key + ":other", "browser", null);
  assert.equal(other.ok, true);
  await other.release();
  child.kill("SIGKILL"); await childExit;
  let recovered;
  for (let i = 0; i < 30; i++) {
    recovered = await acquire(key, "browser", null);
    if (recovered.ok) break;
    await delay(50);
  }
  assert.equal(recovered.ok, true); await recovered.release();
  const previousMode=process.env.CONSOLE_MCP_VISIBLE_OS_LEASES;
  process.env.CONSOLE_MCP_VISIBLE_OS_LEASES="required";
  try {
    const identity={key,pid:123,started:"1"};
    const proof=async()=>identity;
    const owner=await acquire(key,"browser",null);
    assert.equal(owner.ok,true);
    let runCount=0, late;
    let releaseLate;
    const lateGate=new Promise(resolve=>{releaseLate=resolve;});
    try {
      await runWithHeldVisibleProcessLease(key,owner,async()=>{
        await withDirectBrowserOperationLease([9223],async()=>{
          runCount++;
          assert.equal((await acquire(key,"browser",null)).reason,"CROSS_PROCESS_LEASE_BUSY");
          return withDirectBrowserOperationLease([9223],async()=>"nested",proof);
        },proof);
        await assert.rejects(withVisibleProcessLease(key+":wrong",async()=>{throw Error("MUST_NOT_RUN");}),/SCOPE_INVALID/);
        late=lateGate.then(()=>withVisibleProcessLease(key,async()=>{throw Error("MUST_NOT_RUN");}));
      });
      releaseLate();
      await assert.rejects(late,/SCOPE_INVALID/);
      assert.equal(runCount,1);
      assert.equal(owner.isHeld(),true);
    } finally {await owner.release();}
    let probes=0;
    await assert.rejects(withDirectBrowserOperationLease([9223],async()=>{throw Error("MUST_NOT_RUN");},async()=>({...identity,started:String(++probes)})),/IDENTITY_CHANGED/);
    probes=0;
    await assert.rejects(withDirectBrowserOperationLease([9223],async()=>{runCount++;return "must not publish";},async()=>({...identity,started:++probes>2?"changed":"1"})),/IDENTITY_CHANGED/);
    assert.equal(runCount,2);
    assert.equal(await withDirectBrowserOperationLease([9223],async()=>"released",proof),"released");
    assert.equal(await withDirectBrowserOperationLease([9224],async()=>"other-port",async()=>{throw Error("MUST_NOT_PROBE");}),"other-port");
    console.log("DIRECT_BROWSER_OPERATION_LEASE_PASS nested scope reuse, stale scope rejection, browser identity drift and release (mock identity, actual flock)");
  } finally {
    if(previousMode===undefined)delete process.env.CONSOLE_MCP_VISIBLE_OS_LEASES;else process.env.CONSOLE_MCP_VISIBLE_OS_LEASES=previousMode;
  }
  chmodSync(root, 0o755);
  assert.equal((await acquire(key, "browser", null)).reason, "CROSS_PROCESS_LEASE_UNAVAILABLE");
  chmodSync(root, 0o700);
  const badKey = "hardlink";
  const badFile = join(root, createHash("sha256").update(badKey).digest("hex") + ".instance.lock");
  const fixture = join(root, "fixture");
  writeFileSync(fixture, "", {mode: 0o600});
  linkSync(fixture, badFile);
  assert.equal((await acquire(badKey, "browser", null)).reason, "CROSS_PROCESS_LEASE_UNAVAILABLE");
  const linkKey = "symlink";
  symlinkSync(fixture, join(root, createHash("sha256").update(linkKey).digest("hex") + ".instance.lock"));
  assert.equal((await acquire(linkKey, "browser", null)).reason, "CROSS_PROCESS_LEASE_UNAVAILABLE");
  console.log("VISIBLE_BROWSER_PROCESS_LOCK_PASS real cross-process flock, target compatibility, browser exclusion, crash release, root and inode negatives");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const lease of held) await lease.release();
  if (original === undefined) delete process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
  else process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = original;
  rmSync(root, { recursive: true, force: true });
}
