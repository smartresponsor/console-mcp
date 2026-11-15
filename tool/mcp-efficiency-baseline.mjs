#!/usr/bin/env node
/**
 * Offline, read-only summary of existing Console MCP method traces.
 * No network, dependencies, or changes to production files.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function summarize(records, limit = 20, options = {}) {
  const consumerFilter = options.consumer ?? null;
  const trafficOriginFilter = options.trafficOrigin ?? null;
  if (consumerFilter !== null && (typeof consumerFilter !== "string" || !consumerFilter.trim())) throw new TypeError("consumer filter must be nonempty");
  if (trafficOriginFilter !== null && (typeof trafficOriginFilter !== "string" || !trafficOriginFilter.trim())) throw new TypeError("traffic origin filter must be nonempty");
  const starts = new Map();
  const groups = new Map();
  let malformed = 0, ignored = 0, filtered = 0, startsCount = 0, endsCount = 0, unmatchedEnds = 0;
  const byOrigin = new Map();
  for await (const line of records) {
    let event;
    try { event = JSON.parse(line); } catch { malformed++; continue; }
    if (!event || !["method_start", "method_end"].includes(event.event)
      || !["tools/list", "tools/call"].includes(event.method)) { ignored++; continue; }
    const consumer = String(event.consumer || "<unknown>");
    // Only explicit, trusted method-trace metadata can identify synthetic traffic.
    // Historical events without a tag are unclassified, never guessed to be watchdog.
    const origin = typeof event.traffic_origin === "string" && event.traffic_origin.trim()
      ? event.traffic_origin : "unclassified";
    if ((consumerFilter !== null && consumer !== consumerFilter)
      || (trafficOriginFilter !== null && origin !== trafficOriginFilter)) { filtered++; continue; }
    if (event.event === "method_end") byOrigin.set(origin, (byOrigin.get(origin) || 0) + 1);
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
      unmatched_ends: unmatchedEnds, malformed_lines: malformed, ignored_lines: ignored,
      filtered_events: filtered },
    selection: { consumer: consumerFilter, traffic_origin: trafficOriginFilter },
    traffic_origins: Object.fromEntries([...byOrigin.entries()].sort((x, y) => x[0].localeCompare(y[0]))),
    totals: {
      tool_call_events: rows.filter(r => r.tool !== "tools/list").reduce((s, r) => s + r.calls, 0),
      tool_list_events: rows.filter(r => r.tool === "tools/list").reduce((s, r) => s + r.calls, 0)
    },
    limitations: [
      "End-to-end method duration, not exclusive handler duration",
      "Response byte size unavailable in current method trace",
      "Trace may contain multiple/partial requests; aggregate excludes raw arguments and contents",
      "Historical method traces without explicit traffic_origin metadata are unclassified; consumer filtering cannot distinguish supervisor from human Codex traffic"
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
  const optionArgs = process.argv.slice(4);
  const allowed = ["--consumer=", "--traffic-origin="];
  const validOptions = optionArgs.every(arg => allowed.some(prefix => arg.startsWith(prefix) && arg.length > prefix.length))
    && new Set(optionArgs.map(arg => arg.split("=")[0])).size === optionArgs.length;
  const options = {
    consumer: optionArgs.find(arg => arg.startsWith("--consumer="))?.slice("--consumer=".length),
    trafficOrigin: optionArgs.find(arg => arg.startsWith("--traffic-origin="))?.slice("--traffic-origin=".length)
  };
  if (!filePath || !Number.isInteger(limit) || limit < 1 || limit > 500 || !validOptions) {
    console.error("Usage: node tool/mcp-efficiency-baseline.mjs <mcp-method-trace.ndjson> [topN 1..500] [--consumer=chatgpt] [--traffic-origin=supervisor_smoke]");
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await summarize(readLines(filePath), limit, options), null, 2)); }
    catch (error) { console.error(`Baseline failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
  }
}
