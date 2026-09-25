import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.CONSOLE_MCP_DIAGNOSTIC_TRACE_MAX_BYTES = "4096";
process.env.CONSOLE_MCP_DIAGNOSTIC_TRACE_KEEP = "2";
const root = process.cwd();
const { recordMcpRequestTrace } = await import(pathToFileURL(path.join(root, "dist", "Infrastructure", "Diagnostics", "RuntimeDiagnostics.js")));
const dir = await mkdtemp(path.join(os.tmpdir(), "cmcp-trace-rotation-"));
try {
  for (let index = 0; index < 80; index += 1) {
    await recordMcpRequestTrace(dir, {
      timestamp: new Date().toISOString(), correlation_id: `c-${index}`, pid: process.pid, profile: "test", consumer: "test",
      http_method: "POST", path: "/mcp", user_agent: "rotation-regression", client: { payload: "x".repeat(256) },
      auth_mode: "none", auth_success: true, auth_failure_class: null, jsonrpc_id: index, jsonrpc_method: "tools/call",
      http_status: 200, response_completed_at: new Date().toISOString(), elapsed_ms: 1, mcp_dispatch_reached: true,
      transport_handle_completed: true, transport_handle_threw: false, response_finish_fired: true, response_close_fired: false,
      client_close_before_completion: false, response_aborted: false, exception_class: null, exception_message: null, timings: {}
    });
  }
  const names = (await readdir(dir)).sort();
  assert.ok(names.includes("mcp-request-trace.ndjson"));
  assert.ok(names.includes("mcp-request-trace.ndjson.1"));
  assert.ok(names.every((name) => !name.endsWith(".3")), "retention must keep at most two rotated backups");
  const active = await stat(path.join(dir, "mcp-request-trace.ndjson"));
  assert.ok(active.size < 8192, `active trace should remain bounded, got ${active.size}`);
  console.log(JSON.stringify({ ok: true, status: "DIAGNOSTIC_TRACE_ROTATION_GREEN", files: names, active_bytes: active.size }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
