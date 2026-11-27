import assert from "node:assert/strict";
import { withChatPromptScreenshotLease, enforceVisibleBrowserTools } from "../dist/service/visible-browser-tools.js";
import { acquireVisibleProcessLease } from "../dist/service/visible-browser-process-lock.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectVisibleTarget, selectVisibleTarget } from "../dist/service/visible-browser-session.js";
const anchor = { host: "fixture", os: "linux", runtimeOwner: "console-mcp", endpoint: "http://127.0.0.1:9223", browserInstance: "/devtools/browser/abc-123", browserPid: 123, processStartedAt: "456", targetId: "A".repeat(32), verifiedAt: "2026-11-26T00:00:00Z" };
const proof = { ok: true, cdp_ready: true, status: "CDP_TARGET_BOUND", evidence: anchor };
const probes = { select: async () => proof, inspect: async () => proof };
const leaseRoot = mkdtempSync(join(tmpdir(), "screenshot-lease-"));
const priorLeaseRoot = process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
const priorLeaseMode = process.env.CONSOLE_MCP_VISIBLE_OS_LEASES;
try {
  delete process.env.CONSOLE_MCP_VISIBLE_OS_LEASES;
  await assert.rejects(withChatPromptScreenshotLease(async () => { throw new Error("MUST_NOT_RUN"); }, probes), /SHARED_LEASE_REQUIRED/);
  process.env.CONSOLE_MCP_VISIBLE_OS_LEASES = "required";
  process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = leaseRoot;
  let invoked = false;
  await assert.rejects(withChatPromptScreenshotLease(async () => { invoked = true; }, { ...probes, select: async () => ({ ...proof, ok: false }) }), /ADMISSION_DENIED/);
  assert.equal(invoked, false);
  if (process.platform === "linux") {
    const instance = JSON.stringify([anchor.endpoint, anchor.browserInstance]);
    const competing = await acquireVisibleProcessLease(instance, "target", anchor.targetId);
    assert.equal(competing.ok, true);
    try {
      await assert.rejects(withChatPromptScreenshotLease(async () => { throw new Error("MUST_NOT_RUN"); }, probes), /LEASE_BUSY/);
    } finally { await competing.release(); }
    const result = await withChatPromptScreenshotLease(async (_anchor, verify) => {
      await verify();
      await assert.rejects(withChatPromptScreenshotLease(async () => {}, probes), /LEASE_BUSY/);
      return "ok";
    }, probes);
    assert.equal(result, "ok");
    await assert.rejects(withChatPromptScreenshotLease(async () => {}, { ...probes, inspect: async () => ({ ...proof, evidence: { ...anchor, browserPid: 999 } }) }), /ADMISSION_LOST/);
    assert.equal(await withChatPromptScreenshotLease(async () => "released", probes), "released");
    await withChatPromptScreenshotLease(async () => {
      const competing = await acquireVisibleProcessLease(instance, "target", anchor.targetId);
      assert.equal(competing.reason, "CROSS_PROCESS_LEASE_BUSY");
    }, probes);
  } else {
    await assert.rejects(withChatPromptScreenshotLease(async () => {}, probes), /LEASE_UNAVAILABLE/);
  }
} finally {
  if (priorLeaseRoot === undefined) delete process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
  else process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = priorLeaseRoot;
  if (priorLeaseMode === undefined) delete process.env.CONSOLE_MCP_VISIBLE_OS_LEASES;
  else process.env.CONSOLE_MCP_VISIBLE_OS_LEASES = priorLeaseMode;
  rmSync(leaseRoot, { recursive: true, force: true });
}
const root = mkdtempSync(join(tmpdir(), "screenshot-quarantine-"));
const prior = process.env.CONSOLE_WEB_SECRET_ROOT;
try {
  process.env.CONSOLE_WEB_SECRET_ROOT = root;
  let handler;
  let invoked = 0;
  enforceVisibleBrowserTools({ registerTool(_name, _config, callback) { handler = callback; } }, probes)
    .registerTool("write.engine.chat.prompt.screenshot", {}, async () => {
      invoked++;
      mkdirSync(join(root, "quarantine"));
      return { content: [{ type: "image", mimeType: "image/png", data: "fixture" }], structuredContent: { ok: true } };
    });
  const result = await handler({});
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).status, "WEB_SECRET_LOCAL_CLEANUP_REQUIRED");
  assert.equal(result.content.some(x => x.type === "image"), false);
  assert.equal(invoked, 1);
  assert.equal((await handler({})).isError, true);
  assert.equal(invoked, 1);
} finally {
  if (prior === undefined) delete process.env.CONSOLE_WEB_SECRET_ROOT;
  else process.env.CONSOLE_WEB_SECRET_ROOT = prior;
  rmSync(root, { recursive: true, force: true });
}
console.log("chat prompt screenshot supervisor lease and quarantine regression: PASS (mock admission)");
if (process.argv.includes("--live-readonly")) for (const port of [9223, 9224]) {
  const live = await selectVisibleTarget([port], undefined, "screenshot-readiness", false, "cdp");
  console.log(JSON.stringify({ port, ok: live.ok, status: live.status, reason: live.reason, states: live.states, processProven: Boolean(live.evidence.browserPid), verifiedAt: live.evidence.verifiedAt }));
}
// Read-only preflight: no target is opened, no page content is read.
