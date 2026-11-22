import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { replaceViaRepositoryWriteSocket } from "../dist/Infrastructure/Process/RepositoryWriteClient.js";

const root = await mkdtemp(path.join(os.tmpdir(), "console-repo-write-ipc-"));
const workspace = path.join(root, "workspace");
const policyRoot = path.join(root, "config");
const socket = path.join(root, "worker.sock");
const target = path.join(workspace, "sample.txt");
let child;
try {
  await mkdir(workspace);
  await mkdir(path.join(policyRoot, "policy"), { recursive: true });
  await writeFile(target, "alpha beta\n");
  await writeFile(path.join(policyRoot, "policy/allowed-root.json"), JSON.stringify({ defaultRoot: workspace, allowedRoots: [workspace] }));
  await writeFile(path.join(policyRoot, "policy/denied-path.json"), JSON.stringify({ denyBasenames: [], denyExtensions: [], denyPathFragments: [], allowlist: [] }));
  await writeFile(path.join(policyRoot, "policy/allowed-check.json"), JSON.stringify({ defaultTimeoutMs: 1000, checks: {} }));
  child = spawn(process.execPath, ["dist/cli/repository-write-worker.js"], {
    cwd: process.cwd(),
    env: { ...process.env, CONSOLE_MCP_REPO_WRITE_SOCKET: socket, CONSOLE_MCP_REPO_WRITE_POLICY_ROOT: policyRoot, CONSOLE_MCP_TRANSCRIPT_DIR: path.join(root, "transcripts"), CONSOLE_MCP_WORKSPACE_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Worker exited: " + stderr);
    try {
      const s = await stat(socket);
      if (s.isSocket()) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, "worker socket readiness");
  const result = await replaceViaRepositoryWriteSocket(socket, { workspacePath: workspace, filePath: "sample.txt", search: "alpha", replace: "gamma", dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(await readFile(target, "utf8"), "alpha beta\n");
  await assert.rejects(() => replaceViaRepositoryWriteSocket(socket, { workspacePath: workspace, filePath: "sample.txt", search: "alpha", replace: "gamma" }), /disabled pending race-safe/);
  assert.equal(await readFile(target, "utf8"), "alpha beta\n");
  const unicodeResult = await replaceViaRepositoryWriteSocket(socket, { workspacePath: workspace, filePath: "sample.txt", search: "alpha", replace: "Привіт 🌍 — 中文", dryRun: true });
  assert.equal(unicodeResult.ok, true);
  assert.equal(unicodeResult.applied, false);
  assert.equal(await readFile(target, "utf8"), "alpha beta\n");
  await symlink(target, path.join(workspace, "link.txt"));
  await assert.rejects(() => replaceViaRepositoryWriteSocket(socket, { workspacePath: workspace, filePath: "link.txt", search: "alpha", replace: "gamma", dryRun: true }), /symlinks is denied/);
  const malformed = await new Promise((resolve, reject) => {
    const connection = connect(socket);
    let response = "";
    connection.on("connect", () => connection.write(JSON.stringify({ id: randomUUID(), operation: "unknown", input: {} }) + "\n"));
    connection.on("data", chunk => { response += chunk; if (response.includes("\n")) { connection.end(); resolve(JSON.parse(response.split("\n")[0])); } });
    connection.on("error", reject);
  });
  assert.equal(malformed.ok, false);
  const managed = spawn(process.execPath, ["dist/cli/repository-write-worker.js"], {
    cwd: process.cwd(),
    env: { ...process.env, CONSOLE_MCP_MANAGED_RUNTIME: "systemd", CONSOLE_MCP_REPO_WRITE_SOCKET: path.join(root, "managed.sock"), CONSOLE_MCP_REPO_WRITE_POLICY_ROOT: policyRoot, CONSOLE_MCP_REPO_WRITE_RELEASE_DIR: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let managedError = "";
  managed.stderr.on("data", chunk => { managedError += chunk.toString(); });
  const managedExit = await new Promise(resolve => managed.once("exit", resolve));
  assert.notEqual(managedExit, 0, "managed worker without release pin must fail");
  assert.match(managedError, /explicitly pinned release/);
  console.log("Repository writable IPC regression: PASS (dry-run, unicode payload, mutation denied, symlink denied, unknown operation denied)");
} finally {
  if (child) { child.kill("SIGTERM"); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); }); }
  await rm(root, { recursive: true, force: true });
}
