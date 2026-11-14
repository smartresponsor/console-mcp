#!/usr/bin/env node
/**
 * Offline, read-only summary of existing Console MCP method traces.
 * No network, dependencies, or changes to production files.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function summarize(records, limit = 20) {
  const starts = new Map();
  const groups = new Map();
  let malformed = 0, ignored = 0, startsCount = 0, endsCount = 0, unmatchedEnds = 0;
  for await (const line of records) {
    let event;
    try { event = JSON.parse(line); } catch { malformed++; continue; }
    if (!event || !["method_start", "method_end"].includes(event.event)
      || !["tools/list", "tools/call"].includes(event.method)) { ignored++; continue; }
    const key = JSON.stringify([event.correlation_id, event.method, event.jsonrpc_id, event.tool_name]);
    if (event.event === "method_start") {
      starts.set(key, (starts.get(key) || 0) + 1);
      startsCount++;
      continue;
    }
    endsCount++;
    const pending = starts.get(key) || 0;
    if (pending) {
      if (pending === 1) starts.delete(key);
      else starts.set(key, pending - 1);
    } else unmatchedEnds++;
    const name = event.method === "tools/list" ? "tools/list" : String(event.tool_name || "<unknown>");
    const consumer = String(event.consumer || "<unknown>");
    const id = JSON.stringify([consumer, name]);
    const group = groups.get(id) || { consumer, tool: name, count: 0, errors: 0, samples: [] };
    group.count++;
    if ((event.http_status != null && event.http_status >= 400)
      || event.exception_class != null
      || (typeof event.result_classification === "string" && /fail|error|abort/i.test(event.result_classification))) group.errors++;
    if (Number.isFinite(event.elapsed_ms) && event.elapsed_ms >= 0) group.samples.push(event.elapsed_ms);
    groups.set(id, group);
  }
  const percentile = (a, p) => {
    if (!a.length) return null;
    const sorted = [...a].sort((x, y) => x - y);
    return Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 100) / 100;
  };
  const rows = [...groups.values()].map(g => ({
    consumer: g.consumer, tool: g.tool, calls: g.count, errors: g.errors,
    error_rate: Math.round(10000 * g.errors / g.count) / 100,
    p50_ms: percentile(g.samples, .50), p95_ms: percentile(g.samples, .95),
    sampled_calls: g.samples.length
  })).sort((a, b) => b.calls - a.calls || a.consumer.localeCompare(b.consumer) || a.tool.localeCompare(b.tool));
  return {
    schema: "mcp-efficiency-baseline/v1",
    trace_events: { starts: startsCount, ends: endsCount,
      unmatched_starts: [...starts.values()].reduce((a, b) => a + b, 0),
      unmatched_ends: unmatchedEnds, malformed_lines: malformed, ignored_lines: ignored },
    totals: {
      tool_call_events: rows.filter(r => r.tool !== "tools/list").reduce((s, r) => s + r.calls, 0),
      tool_list_events: rows.filter(r => r.tool === "tools/list").reduce((s, r) => s + r.calls, 0)
    },
    limitations: [
      "End-to-end method duration, not exclusive handler duration",
      "Response byte size unavailable in current method trace",
      "Trace may contain multiple/partial requests; aggregate excludes raw arguments and contents"
    ],
    top_tools: rows.slice(0, limit)
  };
}
export async function* readLines(filePath) {
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield line;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const filePath = process.argv[2];
  const limit = process.argv[3] === undefined ? 20 : Number(process.argv[3]);
  if (!filePath || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    console.error("Usage: node tool/mcp-efficiency-baseline.mjs <mcp-method-trace.ndjson> [topN 1..500]");
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await summarize(readLines(filePath), limit), null, 2)); }
    catch (error) { console.error(`Baseline failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
  }
}
