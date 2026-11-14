import assert from "node:assert/strict";
import { summarize } from "./mcp-efficiency-baseline.mjs";

const event = (phase, tool, ms, extra = {}) => JSON.stringify({
  event: phase, method: "tools/call", tool_name: tool,
  correlation_id: "id-" + tool, jsonrpc_id: 1, consumer: "chatgpt",
  elapsed_ms: ms, http_status: 200, result_classification: "success",
  exception_class: null, ...extra
});
const rows = [
  event("method_start", "read_.system.console.health", null),
  event("method_end", "read_.system.console.health", 12),
  event("method_end", "read_.system.console.health", 22, { http_status: 500 }),
  "not json",
  JSON.stringify({ event: "method_start", method: "initialize" })
];
const summary = await summarize(rows);
assert.equal(summary.trace_events.malformed_lines, 1);
assert.equal(summary.trace_events.unmatched_ends, 1);
assert.equal(summary.top_tools[0].calls, 2);
assert.equal(summary.top_tools[0].errors, 1);
assert.equal(summary.top_tools[0].p50_ms, 12);
assert.equal(summary.top_tools[0].p95_ms, 22);
assert.equal(summary.top_tools[0].error_rate, 50);
assert.equal(summary.totals.tool_call_events, 2);
assert.equal(summary.top_tools[0].tool, "read_.system.console.health");
console.log("PASS mcp-efficiency-baseline");
