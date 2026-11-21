import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { withDeploymentSharedAdmission } from "../dist/Infrastructure/Process/DeploymentAdmission.js";
import { startAsyncCommandRun } from "../dist/Infrastructure/Process/AsyncCommandRun.js";
import { buildSafeEnv } from "../dist/Infrastructure/Process/ProcessRuntime.js";
import { runSupervisedCommand } from "../dist/Infrastructure/Process/SupervisedCommand.js";

const prior = process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION;
const root = await mkdtemp(path.join(os.tmpdir(), "stage11-integration-"));
try {
  delete process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION;
  assert.equal(await withDeploymentSharedAdmission(async () => 123), 123);
  process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION = "invalid";
  await assert.rejects(() => withDeploymentSharedAdmission(async () => true),
    /DEPLOYMENT_ADMISSION_CONFIGURATION_INVALID/);
  process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION = "required";
  assert.equal(buildSafeEnv().CONSOLE_MCP_DEPLOYMENT_ADMISSION, "required", "repository worker must inherit mandatory admission");
  let invoked = false;
  await assert.rejects(() => withDeploymentSharedAdmission(async () => {
    invoked = true;
    return true;
  }), /DEPLOYMENT_ADMISSION_(UNAVAILABLE|LOST_BEFORE_OPERATION|HELPER_LOST_FENCE_RETAINED)/);
  assert.equal(invoked, false, "callback must not start without admission");
  await assert.rejects(() => runSupervisedCommand(root, process.execPath, ["-e", "require(\'node:fs\').writeFileSync(process.argv[1],\'bypass\')", path.join(root, "supervised-bypass.txt")], 10000), /DEPLOYMENT_ADMISSION_(UNAVAILABLE|HELPER_LOST_FENCE_RETAINED)/);
  await assert.rejects(() => readFile(path.join(root, "supervised-bypass.txt")), { code: "ENOENT" });
  const marker = path.join(root, "marker.txt");
  await assert.rejects(() => startAsyncCommandRun({
    workspacePath: root, command: "node", args: ["-e",
      "require('node:fs').writeFileSync(process.argv[1],'spawned')", marker],
    timeoutMs: 10000, kind: "stage11-admission-fixture",
  }), /DEPLOYMENT_ADMISSION_(UNAVAILABLE|LOST_BEFORE_OPERATION|HELPER_LOST_FENCE_RETAINED)/);
  await assert.rejects(() => readFile(marker), { code: "ENOENT" });
  console.log("STAGE11_NODE_ADMISSION_FAIL_CLOSED_PASS");
} finally {
  if (prior === undefined) delete process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION;
  else process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION = prior;
  await rm(root, { recursive: true, force: true });
}
