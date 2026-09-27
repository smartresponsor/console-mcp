#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const { classifyActionMarkerFromText } = await import(pathToFileURL(path.join(root, "dist", "engine", "action-marker-router.js")).href);

const limitArg = process.argv.find((value) => value.startsWith("--per-category="));
const perCategory = clampInt(limitArg?.slice("--per-category=".length), 5, 1, 25);
const eventLog = path.join(root, "var", "log", "engine", "event.jsonl");
const taskDir = path.join(root, "var", "run", "engine", "task");

const latestCapture = new Map();
const latestDecision = new Map();

for (const line of (await readFile(eventLog, "utf8").catch(() => "")).split(/\r?\n/)) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  const taskId = typeof event.task_id === "string" ? event.task_id : null;
  if (!taskId) continue;

  if (event.event === "executor_answer_captured") {
    const text = event?.data?.latest_assistant?.text;
    if (typeof text === "string" && text.trim()) {
      latestCapture.set(taskId, {
        event_id: event.event_id ?? null,
        ts: event.ts ?? null,
        text,
        ready_to_delete: event?.data?.ready_to_delete === true,
      });
    }
  }

  if (event.event === "engine_decision_recorded") {
    latestDecision.set(taskId, {
      event_id: event.event_id ?? null,
      ts: event.ts ?? null,
      marker: typeof event?.data?.decision_status === "string"
        ? event.data.decision_status
        : (typeof event?.data?.marker === "string" ? event.data.marker : null),
      confidence: typeof event?.data?.decision_confidence === "number"
        ? event.data.decision_confidence
        : (typeof event?.data?.confidence === "number" ? event.data.confidence : null),
    });
  }
}

const taskNames = await readdir(taskDir).catch(() => []);
const candidates = [];

for (const name of taskNames) {
  if (!name.endsWith(".json")) continue;
  let task;
  try { task = JSON.parse(await readFile(path.join(taskDir, name), "utf8")); } catch { continue; }

  const taskId = typeof task.task_id === "string" ? task.task_id : name.slice(0, -5);
  const capture = latestCapture.get(taskId);
  if (!capture) continue;

  const current = classifyActionMarkerFromText(capture.text);
  const recorded = latestDecision.get(taskId);
  const category = classifyCategory(current.marker, capture.ready_to_delete, capture.text);

  candidates.push({
    task_id: taskId,
    component: task.component_label ?? task.component ?? null,
    workspace_path: task.workspace_path ?? null,
    task_status: task.status ?? null,
    captured_at: capture.ts,
    answer_event_id: capture.event_id,
    answer_length: capture.text.length,
    answer_hash: task.assistant_hash ?? null,
    ready_to_delete: capture.ready_to_delete,
    recorded_decision: recorded?.marker ?? task.decision_status ?? null,
    recorded_confidence: recorded?.confidence ?? task.decision_confidence ?? null,
    current_router_marker: current.marker,
    current_router_confidence: current.confidence,
    current_router_signals: current.signals,
    category,
    has_cyrillic: /[А-Яа-яЁёІіЇїЄє]/u.test(capture.text),
    preview: compact(capture.text, 420),
  });
}

candidates.sort((a, b) => String(b.captured_at ?? "").localeCompare(String(a.captured_at ?? "")));

const grouped = {};
for (const item of candidates) {
  (grouped[item.category] ??= []).push(item);
}

const selected = [];
for (const category of Object.keys(grouped).sort()) {
  const bucket = grouped[category];
  const multilingual = bucket.filter((item) => item.has_cyrillic);
  const plain = bucket.filter((item) => !item.has_cyrillic);
  const chosen = [];
  for (const item of interleave(multilingual, plain)) {
    if (chosen.length >= perCategory) break;
    chosen.push(item);
  }
  selected.push(...chosen);
}

console.log(JSON.stringify({
  ok: true,
  status: "JEV_CHALLENGER_CANDIDATES_READY",
  event_log: eventLog,
  task_dir: taskDir,
  captured_task_count: candidates.length,
  per_category_limit: perCategory,
  category_counts: Object.fromEntries(Object.entries(grouped).map(([key, value]) => [key, value.length])),
  selected_count: selected.length,
  selected,
}, null, 2));

function classifyCategory(marker, readyToDelete, text) {
  if (readyToDelete) return "ready_to_delete";
  if (marker === "done") return "done";
  if (marker === "human decision required") return "human";
  if (marker.includes("fail")) return "failure";
  if (marker.includes("blocker")) return "blocker";
  if (marker === "next" || marker === "commit and next") return "next";
  if (marker === "continue" || marker === "commit and continue") return "continue";
  if (marker === "recheck and continue") return "recheck";
  if (/resolved|fixed|green|pass|исправлен|устран|закрыт/iu.test(text)) return "resolved_or_green";
  return "other";
}

function interleave(a, b) {
  const result = [];
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i]) result.push(a[i]);
    if (b[i]) result.push(b[i]);
  }
  return result;
}

function compact(value, max) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : normalized.slice(0, max) + "...";
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
