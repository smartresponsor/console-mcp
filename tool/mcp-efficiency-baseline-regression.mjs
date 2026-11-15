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
// Verify the same reducer accepts an asynchronous line stream without materializing the input.
async function* stream() {
  for (const line of rows) yield line;
}
const streamed = await summarize(stream());
assert.deepEqual(streamed, summary);
// Reusing the same correlation identifier after a completed call must not
// leave stale pending starts or misclassify a later completed call.
const repeated = await summarize([
  event("method_start", "x", null),
  event("method_end", "x", 10),
  event("method_start", "x", null),
  event("method_end", "x", 20)
]);
assert.equal(repeated.trace_events.unmatched_starts, 0);
assert.equal(repeated.trace_events.unmatched_ends, 0);
assert.equal(repeated.top_tools[0].calls, 2);
// Consumers can be selected exactly; do not infer supervisor origin from method name.
const mixed = [
  event("method_start", "x", null, { consumer: "codex" }),
  event("method_end", "x", 7, { consumer: "codex", traffic_origin: "supervisor_smoke" }),
  event("method_start", "y", null, { consumer: "chatgpt" }),
  event("method_end", "y", 9, { consumer: "chatgpt" }),
];
const chatgptOnly = await summarize(mixed, 20, { consumer: "chatgpt" });
assert.equal(chatgptOnly.totals.tool_call_events, 1);
assert.equal(chatgptOnly.trace_events.filtered_events, 2);
assert.deepEqual(chatgptOnly.traffic_origins, { unclassified: 1 });
assert.equal(chatgptOnly.trace_events.unmatched_starts, 0);
const explicitlyTagged = await summarize([
  event("method_start", "x", null, { traffic_origin: "supervisor_smoke" }),
  event("method_end", "x", 7, { traffic_origin: "supervisor_smoke" }),
  event("method_start", "y", null), event("method_end", "y", 9),
], 20, { trafficOrigin: "supervisor_smoke" });
assert.equal(explicitlyTagged.totals.tool_call_events, 1);
assert.equal(explicitlyTagged.trace_events.filtered_events, 2);
assert.deepEqual(explicitlyTagged.traffic_origins, { supervisor_smoke: 1 });
await assert.rejects(summarize([], 20, { consumer: "" }), /nonempty/);
console.log("PASS mcp-efficiency-baseline");
