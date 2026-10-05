import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { callDevToolsRuntimeEvaluate } from "../dist/tool/chatgpt-message-capture.js";
import { buildEngineWorkspaceAccessLines, isEngineEphemeralCleanupSafe } from "../dist/engine/engine-core.js";
import { isWithinRoot } from "../dist/Policy/PathGuard.js";
import { replaceTextInFile } from "../dist/Infrastructure/FileSystem/FileEdit.js";

const base = { browser_target_policy: "ephemeral", submitted_at: "now", chat_id: "fixture", answer_captured_at: "2026-10-05T00:00:00.000Z", status: "waiting_runtime" };
assert.equal(isEngineEphemeralCleanupSafe(base), false);
assert.equal(isEngineEphemeralCleanupSafe({ ...base, status: "evaluating" }), false);
assert.equal(isEngineEphemeralCleanupSafe({ ...base, status: "evaluating", decision_recorded_at: "2026-10-05T00:00:01.000Z" }), false);
assert.equal(isEngineEphemeralCleanupSafe({ ...base, decision_recorded_at: "2026-10-05T00:00:01.000Z" }), true);
for (const status of ["executing", "waiting_assistant", "unknown"]) assert.equal(isEngineEphemeralCleanupSafe({ ...base, status, decision_recorded_at: "2026-10-05T00:00:01.000Z" }), false);
assert.equal(isEngineEphemeralCleanupSafe({ ...base, decision_recorded_at: "2026-10-04T23:59:59.000Z" }), false, "previous-round decision cannot authorize current-answer cleanup");
const linux = buildEngineWorkspaceAccessLines("/fixture/product/addressing", "/fixture/product").join("\n");
assert.match(linux, /Linux\/Ubuntu/); assert.match(linux, /workspace_root=\/fixture\/product/);
assert.match(linux, /CONNECTOR_WORKSPACE_MISMATCH/); assert.doesNotMatch(linux, /Windows Workspace path|Windows workspace is available/);
assert.match(buildEngineWorkspaceAccessLines("D:\\Product\\Addressing", "D:\\Product").join("\n"), /Treat the Windows Workspace path/);
const original = globalThis.WebSocket;
try {
  for (const mode of ["before-open", "during-capture", "success", "close", "timeout", "malformed"]) {
    let socket; let closeCount = 0; let settlements = 0;
    class FakeSocket {
      constructor() { socket = this; queueMicrotask(() => {
        if (mode === "before-open") this.onerror?.("fixture error");
        else if (mode === "close") this.onclose?.();
        else this.onopen?.();
      }); }
      send() { queueMicrotask(() => {
        if (mode === "during-capture") this.onerror?.("fixture error");
        if (mode === "success") this.onmessage?.({ data: JSON.stringify({ id: 1, result: { result: { value: "captured" } } }) });
        if (mode === "malformed") this.onmessage?.({ data: "not JSON" });
      }); }
      close() { closeCount++; this.onerror?.("close error"); this.onclose?.(); }
    }
    globalThis.WebSocket = FakeSocket;
    const promise = callDevToolsRuntimeEvaluate("ws://fixture", "1 + 1", 20).then(value => { settlements++; return value; }, error => { settlements++; throw error; });
    const staleError = socket.onerror; const staleClose = socket.onclose;
    if (mode === "success") assert.equal(await promise, "captured"); else await assert.rejects(promise);
    staleError?.("repeated error"); staleClose?.(); staleError?.("explicit cleanup after error");
    assert.equal(closeCount, 1); assert.equal(settlements, 1); assert.equal(socket.onerror, null); assert.equal(socket.onclose, null);
  }
} finally { globalThis.WebSocket = original; }
const temp = await mkdtemp(path.join(tmpdir(), "ubuntu-engine-repair-"));
try {
  const child = path.join(temp, "repo"); await mkdir(child); await writeFile(path.join(child, "fixture.txt"), "before");
  const policy = { allowedRoots: [temp], workspaceRoot: path.join(temp, "umbrella"), transcriptDir: path.join(temp, "transcripts"), deniedPath: { allowlist: [], denyBasenames: ["secret.txt"], denyExtensions: [], denyPathFragments: [] } };
  for (const workspace of [temp, child]) {
    const result = await replaceTextInFile(policy, { workspacePath: workspace, filePath: path.join(child, "fixture.txt"), search: "before", replace: "after", dryRun: true });
    assert.equal(result.ok, true); assert.equal(result.applied, false);
  }
  assert.equal(await readFile(path.join(child, "fixture.txt"), "utf8"), "before");
  for (const escape of [temp + "2", path.join(temp, "..", "escape")]) await assert.rejects(replaceTextInFile(policy, { workspacePath: escape, filePath: "fixture.txt", search: "before", replace: "after", dryRun: true }), /outside the allowed roots/);
  await assert.rejects(replaceTextInFile(policy, { workspacePath: child, filePath: "secret.txt", search: "before", replace: "after", dryRun: true }), /denied basename/);
  assert.equal(isWithinRoot("D:\\Product\\Repo", "D:\\Product"), true);
  assert.equal(isWithinRoot("D:\\Product2\\Repo", "D:\\Product"), false);
  if (process.platform === "linux") {
    const bin = path.join(temp, "bin"); await mkdir(bin);
    await writeFile(path.join(bin, "node"), `#!/bin/sh\ncase "$1" in */dist/cli/ubuntu-dev-console-cli.js) ;; *) exit 90;; esac\nprintf '{"ok":true,"command":"%s"}\\n' "$2"\n`, { mode: 0o755 });
    const script = fileURLToPath(new URL("dev-console.ps1", import.meta.url));
    for (const command of ["browser-status", "browser-ensure-visible", "chatgpt-page-status", "chatgpt-session-status", "stack-preflight"]) {
      const result = spawnSync("pwsh", ["-NoProfile", "-File", script, command], { encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
      assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).command, command);
      assert.doesNotMatch(result.stderr, /Get-CimInstance/);
    }
  }
} finally { await rm(temp, { recursive: true, force: true }); }
console.log("Ubuntu Engine repair regressions: PASS");
