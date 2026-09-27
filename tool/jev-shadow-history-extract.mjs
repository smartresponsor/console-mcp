#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyActionMarkerFromText, normalizeActionMarker } from "../dist/engine/action-marker-router.js";

function parseArgs(argv) {
  const args = {
    eventLog: path.resolve("var/log/engine/event.jsonl"),
    output: "",
    limit: 0,
    samplePerMarker: 0,
    onlyMarker: "",
    excludeLedger: "",
    prioritize: false,
    summaryOnly: false,
    includeText: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const take = () => argv[++index] ?? "";
    if (key === "--event-log") args.eventLog = path.resolve(take());
    else if (key === "--output") args.output = path.resolve(take());
    else if (key === "--limit") args.limit = Math.max(0, Number.parseInt(take(), 10) || 0);
    else if (key === "--sample-per-marker") args.samplePerMarker = Math.max(0, Number.parseInt(take(), 10) || 0);
    else if (key === "--only-marker") args.onlyMarker = take().trim();
    else if (key === "--exclude-ledger") args.excludeLedger = path.resolve(take());
    else if (key === "--prioritize") args.prioritize = true;
    else if (key === "--summary-only") args.summaryOnly = true;
    else if (key === "--include-text") args.includeText = true;
    else throw new Error(`Unknown argument: ${key}`);
  }

  return args;
}

function asObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactSignals(value) {
  const object = asObject(value);
  if (!object) return {};
  const result = {};
  for (const [key, item] of Object.entries(object)) {
    const number = asNumber(item);
    if (number !== null) result[key] = number;
  }
  return result;
}

function normalizeHistoricalMarker(value) {
  const legacy = {
    GREEN: "continue",
    CONTINUE: "continue",
    RED: "fix fail and continue",
    NEEDS_USER: "human decision required",
  };
  if (Object.prototype.hasOwnProperty.call(legacy, value)) return legacy[value];
  return normalizeActionMarker(value) ?? value;
}

function parseJsonLines(text) {
  const events = [];
  const errors = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (asObject(parsed)) events.push(parsed);
    } catch (error) {
      errors.push({
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { events, errors };
}

function collectPairs(events) {
  const latestCaptureByTask = new Map();
  const candidates = [];

  for (const event of events) {
    const taskId = asString(event.task_id);
    if (!taskId) continue;

    if (event.event === "executor_answer_captured") {
      const data = asObject(event.data) ?? {};
      const latestAssistant = asObject(data.latest_assistant) ?? {};
      const text = asString(latestAssistant.text);
      if (!text) continue;
      latestCaptureByTask.set(taskId, {
        event_id: asString(event.event_id),
        ts: asString(event.ts),
        text,
        assistant_hash: asString(data.assistant_hash) ?? asString(latestAssistant.hash),
        ready_to_delete: typeof data.ready_to_delete === "boolean" ? data.ready_to_delete : null,
      });
      continue;
    }

    if (event.event !== "engine_decision_recorded") continue;

    const capture = latestCaptureByTask.get(taskId);
    if (!capture) continue;

    const data = asObject(event.data) ?? {};
    const marker = asString(data.decision_status) ?? asString(data.marker) ?? asString(data.status);
    if (!marker) continue;

    const currentRouter = classifyActionMarkerFromText(capture.text);

    const normalizedMarker = normalizeHistoricalMarker(marker);

    candidates.push({
      task_id: taskId,
      capture_event_id: capture.event_id,
      decision_event_id: asString(event.event_id),
      captured_at: capture.ts,
      decision_recorded_at: asString(data.decision_recorded_at) ?? asString(event.ts),
      historical_marker: marker,
      deterministic_marker: normalizedMarker,
      normalized_marker: normalizeHistoricalMarker(marker),
      current_router_marker: currentRouter.marker,
      historical_marker_drift: currentRouter.marker !== normalizeHistoricalMarker(marker),
      current_router_confidence: currentRouter.confidence,
      current_router_signals: currentRouter.signals,
      deterministic_confidence: asNumber(data.decision_confidence) ?? asNumber(data.confidence),
      deterministic_signals: compactSignals(data.decision_signals ?? data.signals),
      ready_to_delete: capture.ready_to_delete,
      assistant_hash: capture.assistant_hash,
      answer_length: capture.text.length,
      answer_text: capture.text,
    });
  }

  return candidates;
}

function summarize(candidates) {
  const markers = {};
  const normalizedMarkers = {};
  const currentRouterMarkers = {};
  let totalChars = 0;
  let readyTrue = 0;
  let readyFalse = 0;
  let readyNull = 0;
  let historicalMarkerDrift = 0;

  for (const candidate of candidates) {
    markers[candidate.deterministic_marker] = (markers[candidate.deterministic_marker] ?? 0) + 1;
    normalizedMarkers[candidate.normalized_marker] = (normalizedMarkers[candidate.normalized_marker] ?? 0) + 1;
    currentRouterMarkers[candidate.current_router_marker] = (currentRouterMarkers[candidate.current_router_marker] ?? 0) + 1;
    totalChars += candidate.answer_length;
    if (candidate.historical_marker_drift) historicalMarkerDrift += 1;
    if (candidate.ready_to_delete === true) readyTrue += 1;
    else if (candidate.ready_to_delete === false) readyFalse += 1;
    else readyNull += 1;
  }

  return {
    paired_decision_count: candidates.length,
    marker_counts: markers,
    normalized_marker_counts: normalizedMarkers,
    current_router_marker_counts: currentRouterMarkers,
    historical_marker_drift_count: historicalMarkerDrift,
    historical_marker_drift_rate: candidates.length === 0 ? 0 : Number((historicalMarkerDrift / candidates.length).toFixed(4)),
    ready_to_delete: {
      true: readyTrue,
      false: readyFalse,
      null: readyNull,
    },
    average_answer_length: candidates.length === 0 ? 0 : Math.round(totalChars / candidates.length),
  };
}

async function loadExcludedTaskIds(filePath) {
  if (!filePath) return new Set();
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  const cases = Array.isArray(parsed?.cases) ? parsed.cases : [];
  return new Set(cases.map((item) => asString(item?.task_id)).filter(Boolean));
}

function candidatePriority(candidate) {
  let score = 0;
  if (candidate.ready_to_delete === true) score += 8;
  if (candidate.historical_marker_drift) score += 6;
  if (candidate.current_router_marker === "done") score += 7;
  if (candidate.current_router_marker === "human decision required") score += 7;
  if (candidate.current_router_marker === "fix blocker and continue") score += 3;
  if (candidate.current_router_marker === "fix fail and continue") score += 3;
  if ((candidate.current_router_confidence ?? 0) >= 0.8) score += 2;
  if (candidate.answer_length >= 300 && candidate.answer_length <= 5000) score += 1;
  return score;
}

function prioritizeCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const score = candidatePriority(b) - candidatePriority(a);
    if (score !== 0) return score;
    return String(b.decision_recorded_at).localeCompare(String(a.decision_recorded_at));
  });
}

function samplePerMarker(candidates, count) {
  if (!Number.isInteger(count) || count <= 0) return candidates;
  const selected = [];
  const buckets = new Map();
  for (const candidate of candidates) {
    const key = candidate.current_router_marker;
    const bucket = buckets.get(key) ?? [];
    if (bucket.length < count) bucket.push(candidate);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) selected.push(...bucket);
  return selected.sort((a, b) => String(a.decision_recorded_at).localeCompare(String(b.decision_recorded_at)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readFile(args.eventLog, "utf8");
  const parsed = parseJsonLines(raw);
  let candidates = collectPairs(parsed.events);
  const excludedTaskIds = await loadExcludedTaskIds(args.excludeLedger);
  if (excludedTaskIds.size > 0) {
    candidates = candidates.filter((candidate) => !excludedTaskIds.has(candidate.task_id));
  }
  if (args.prioritize) {
    candidates = prioritizeCandidates(candidates);
  }
  if (args.onlyMarker) {
    candidates = candidates.filter((candidate) => candidate.current_router_marker === args.onlyMarker);
  }
  candidates = samplePerMarker(candidates, args.samplePerMarker);

  if (args.limit > 0 && candidates.length > args.limit) {
    candidates = candidates.slice(-args.limit);
  }

  const payload = {
    ok: parsed.errors.length === 0,
    status: parsed.errors.length === 0
      ? "JEV_SHADOW_HISTORY_CANDIDATES_READY"
      : "JEV_SHADOW_HISTORY_CANDIDATES_WITH_PARSE_ERRORS",
    event_log: args.eventLog,
    event_count: parsed.events.length,
    parse_errors: parsed.errors,
    summary: summarize(candidates),
    candidates: args.summaryOnly ? [] : candidates.map((candidate) => args.includeText
      ? candidate
      : {
          ...candidate,
          answer_text: undefined,
          answer_preview: candidate.answer_text.slice(0, 500),
        }),
  };

  const output = `${JSON.stringify(payload, null, 2)}\n`;
  if (args.output) {
    await writeFile(args.output, output, "utf8");
  }
  process.stdout.write(output);
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    status: "JEV_SHADOW_HISTORY_EXTRACT_FAILED",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
