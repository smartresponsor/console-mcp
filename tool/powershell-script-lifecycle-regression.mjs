import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPowerShellScriptTool } from "../dist/tool/powershell-script.js";

const root = await mkdtemp(path.join(os.tmpdir(), "powershell-script-lifecycle-"));
await mkdir(path.join(root, "tool"), { recursive: true });
await writeFile(path.join(root, "tool", "quick.ps1"), "Write-Output M2_LIFECYCLE_OK\nStart-Sleep -Milliseconds 200\n");
await writeFile(path.join(root, "tool", "slow.ps1"), "Write-Output M2_LIFECYCLE_WAIT\nStart-Sleep -Seconds 60\n");
const server = new McpServer({ name: "powershell-lifecycle-regression", version: "1.0.0" });
registerPowerShellScriptTool(server, { allowedRoots: [root] }, { mode: "bearer", bearerTokens: ["test-only"] });
const client = new Client({ name: "powershell-lifecycle-client", version: "1.0.0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
let activeRunId = null;
const call = async (name, args) => {
  const raw = await client.callTool({ name, arguments: args });
  if (!raw.structuredContent) throw new Error(`no structuredContent on ${name}: ${JSON.stringify(raw).slice(0,500)}`);
  return raw.structuredContent;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const poll = async (id, wanted) => {
  for (let n=0; n<45; n++) {
    const s = await call("read_.repo.powershell.script.status", { workspacePath: root, runId: id });
    if (wanted.includes(s.status)) return s;
    await pause(150);
  }
  throw new Error(`status timeout for ${id}`);
};
try {
  await server.connect(st);
  await client.connect(ct);
  const quick = await call("write.repo.powershell.script.start", { workspacePath: root, scriptPath: "tool/quick.ps1", executable: "pwsh", confirmRun: true, timeoutMs: 12000 });
  assert.equal(quick.ok, true, JSON.stringify(quick));
  activeRunId = quick.run_id;
  const completed = await poll(activeRunId, ["succeeded", "failed", "timed_out"]);
  assert.equal(completed.status, "succeeded", JSON.stringify(completed));
  assert.equal(completed.exit_code, 0);
  const out = await call("read_.repo.powershell.script.output", { workspacePath: root, runId: activeRunId });
  assert.match(out.stdout, /M2_LIFECYCLE_OK/);
  console.log("LIFECYCLE_START_STATUS_OUTPUT_PASS", process.platform);
  activeRunId = null;
  const stopRun = await call("write.repo.powershell.script.start", { workspacePath: root, scriptPath: "tool/slow.ps1", executable: "pwsh", confirmRun: true, timeoutMs: 20000 });
  assert.equal(stopRun.ok, true);
  activeRunId = stopRun.run_id;
  const stopped = await call("write.repo.powershell.script.stop", { workspacePath: root, runId: activeRunId, confirmStop: true });
  assert.equal(stopped.status, "stopped", JSON.stringify(stopped));
  const stoppedAgain = await call("write.repo.powershell.script.stop", { workspacePath: root, runId: activeRunId, confirmStop: true });
  assert.equal(stoppedAgain.already_terminal, true);
  console.log("LIFECYCLE_STOP_IDEMPOTENT_PASS", process.platform);
  activeRunId = null;
  const timedRun = await call("write.repo.powershell.script.start", { workspacePath: root, scriptPath: "tool/slow.ps1", executable: "pwsh", confirmRun: true, timeoutMs: 1300 });
  assert.equal(timedRun.ok, true);
  activeRunId = timedRun.run_id;
  const timed = await poll(activeRunId, ["timed_out", "failed", "succeeded"]);
  assert.equal(timed.status, "timed_out", JSON.stringify(timed));
  console.log("LIFECYCLE_TIMEOUT_PASS", process.platform);
  activeRunId = null;
  console.log("M2_PR202_MCP_LIFECYCLE_ALL_PASS");
} finally {
  if (activeRunId) {
    try { await call("write.repo.powershell.script.stop", { workspacePath: root, runId: activeRunId, confirmStop: true }); } catch {}
  }
  await client.close().catch(()=>{});
  await server.close().catch(()=>{});
  await rm(root, {recursive:true,force:true});
}
