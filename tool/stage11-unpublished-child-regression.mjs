import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { terminateUnpublishedAsyncChild } from "../dist/Infrastructure/Process/AsyncCommandRun.js";

if (process.platform !== "linux") {
  console.log("STAGE11_UNPUBLISHED_CHILD_LINUX_ONLY_SKIP");
  process.exit(0);
}
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  detached: true, stdio: ["ignore", "ignore", "ignore"], shell: false,
});
assert.ok(child.pid > 0);
try {
  process.kill(-child.pid, 0);
  await terminateUnpublishedAsyncChild(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null, "child reaped");
  assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
  console.log("STAGE11_UNPUBLISHED_CHILD_PROCESS_GROUP_REAP_PASS");
} finally {
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
}
