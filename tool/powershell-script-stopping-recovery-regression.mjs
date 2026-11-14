import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPowerShellScriptTool } from "../dist/tool/powershell-script.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "powershell-stopping-recovery-"));
await mkdir(path.join(workspace, "tool"), { recursive: true });
await writeFile(path.join(workspace, "tool", "quick.ps1"), "Write-Output RECOVERY_SLOT_AVAILABLE\n");
const server = new McpServer({ name: "stopping-recovery", version: "1.0.0" });
registerPowerShellScriptTool(server, { allowedRoots: [workspace] }, { mode: "bearer", bearerTokens: ["test"] });
const client = new Client({ name: "stopping-recovery-client", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = async (name, args) => {
  const reply = await client.callTool({ name, arguments: args });
  assert.ok(reply.structuredContent);
  return reply.structuredContent;
};
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
};
const waitForDead = async pid => {
  for (let i = 0; i < 50; i++) {
    if (!alive(pid)) return;
    await sleep(100);
  }
  throw Error("Recovered child process still alive: " + pid);
};
const seedStoppingRun = async (pid, reason, deadlineOffsetMs) => {
  const runId = randomUUID();
  const directory = path.join(workspace, ".console-mcp", "powershell-script-run", runId);
  await mkdir(directory, { recursive: true });
  const stdoutPath = path.join(directory, "stdout.log");
  const stderrPath = path.join(directory, "stderr.log");
  await writeFile(stdoutPath, "");
  await writeFile(stderrPath, "");
  const state = {
    schemaVersion: 1, runId, status: "stopping", pid, executable: "pwsh",
    workspacePath: workspace, scriptPath: path.join(workspace, "tool", "quick.ps1"),
    scriptRelativePath: "tool/quick.ps1", arguments: [],
    startedAt: new Date(Date.now() - 2000).toISOString(),
    deadlineAt: new Date(Date.now() + deadlineOffsetMs).toISOString(),
    finishedAt: null, exitCode: null, stopReason: reason,
    stdoutPath, stderrPath, stdoutBytes: 0, stderrBytes: 0,
    stdoutTruncated: false, stderrTruncated: false,
  };
  await writeFile(path.join(directory, "state.json"), JSON.stringify(state));
  return runId;
};

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  for (const reason of ["requested", "runtime_limit_exceeded"]) {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true, stdio: "ignore",
    });
    assert.ok(child.pid);
    children.push(child);
    // An orphaned detached process is exactly what can survive a connector restart.
    const id = await seedStoppingRun(child.pid, reason, reason === "requested" ? 120000 : -1000);
    const result = await call("read_.repo.powershell.script.status", { workspacePath: workspace, runId: id });
    assert.equal(result.status, reason === "requested" ? "stopped" : "timed_out", JSON.stringify(result));
    assert.equal(result.stop_reason, reason);
    await waitForDead(child.pid);
    console.log("STOPPING_RECOVERY_" + reason.toUpperCase() + "_PASS", process.platform);
  }
  // Four old persisted 'stopping' slots must not block a fresh start after restart.
  for (let i = 0; i < 4; i++) await seedStoppingRun(0, "requested", 120000);
  const start = await call("write.repo.powershell.script.start", {
    workspacePath: workspace, scriptPath: "tool/quick.ps1",
    executable: "pwsh", confirmRun: true, timeoutMs: 15000,
  });
  assert.equal(start.ok, true, JSON.stringify(start));
  let status;
  for (let i=0; i<50; i++) {
    status = await call("read_.repo.powershell.script.status", { workspacePath: workspace, runId: start.run_id });
    if (status.status === "succeeded") break;
    await sleep(100);
  }
  assert.equal(status.status, "succeeded", JSON.stringify(status));
  console.log("STOPPING_RECOVERY_CONCURRENCY_SLOT_PASS", process.platform);
  console.log("STOPPING_RECOVERY_ALL_PASS");
} finally {
  for (const child of children) {
    if (!child.pid || !alive(child.pid)) continue;
    try {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {stdio:"ignore"});
        await new Promise(resolve=>killer.once("close",resolve));
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {}
  }
  await client.close().catch(()=>{});
  await server.close().catch(()=>{});
  await rm(workspace, { recursive: true, force: true });
}
