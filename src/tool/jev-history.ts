import { readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { createEnginePaths } from "../engine/engine-core.js";
import { classifyActionMarkerFromText, type ActionMarker } from "../engine/action-marker-router.js";
import {
  assessJevEngineShadowResponse,
  buildJevEngineShadowInput,
} from "../engine/jev-shadow-contract.js";
import { executeAsk } from "./ask.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

type HistoricalCandidate = {
  taskId: string;
  captureEventId: string | null;
  decisionEventId: string | null;
  capturedAt: string | null;
  decisionRecordedAt: string | null;
  answer: string;
  currentMarker: ActionMarker;
  currentConfidence: number;
  historicalMarker: string | null;
};

const SEMANTIC_MARKERS = new Set<ActionMarker>([
  "continue",
  "next",
  "done",
  "human decision required",
  "fix fail and continue",
  "fix blocker and continue",
  "recheck and continue",
]);

export function registerJevHistoryTool(
  server: McpServer,
  policy: ConsolePolicy,
  baseDir: string,
  authConfig: ConsoleAuthConfig,
): void {
  server.registerTool(
    "read_.engine.jev.history.evaluate",
    {
      description: "Replay current deterministic routing over historical Engine captured answers, select a balanced semantic sample, evaluate it with Jev, and return parity/abstention/latency metrics. Read-only and non-authoritative.",
      inputSchema: z.object({
        samplePerMarker: z.number().int().min(1).max(20).default(3),
        maxCases: z.number().int().min(1).max(100).default(20),
        concurrency: z.number().int().min(1).max(4).default(2),
        timeoutMs: z.number().int().min(5000).max(60000).default(20000),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ samplePerMarker, maxCases, concurrency, timeoutMs }) => {
      const engineRoot = path.resolve(baseDir);
      const paths = createEnginePaths(engineRoot);
      const raw = await readFile(paths.eventLog, "utf8");
      const candidates = collectHistoricalCandidates(raw);
      const selected = selectBalancedCandidates(candidates, samplePerMarker, maxCases);

      const results: Array<Record<string, unknown>> = [];
      const startedAt = Date.now();

      const evaluateOne = async (candidate: HistoricalCandidate): Promise<Record<string, unknown>> => {
        const request = buildJevEngineShadowInput(candidate.answer, {});
        const result = await executeAsk(
          policy,
          baseDir,
          engineRoot,
          JSON.stringify(request),
          "typesafe/jev",
          256,
          0,
          timeoutMs,
          true,
          undefined,
        );

        if (!result.ok || !result.stdout_json_parse_ok) {
          return {
            task_id: candidate.taskId,
            capture_event_id: candidate.captureEventId,
            decision_event_id: candidate.decisionEventId,
            current_router_marker: candidate.currentMarker,
            current_router_confidence: candidate.currentConfidence,
            historical_marker: candidate.historicalMarker,
            evaluation_status: "transport_failed",
            duration_ms: result.duration_ms,
            error: compact(result.stderr || "Jev response was not valid JSON."),
          };
        }

        const assessment = assessJevEngineShadowResponse(
          result.stdout_json,
          candidate.currentMarker,
        );

        return {
          task_id: candidate.taskId,
          capture_event_id: candidate.captureEventId,
          decision_event_id: candidate.decisionEventId,
          captured_at: candidate.capturedAt,
          decision_recorded_at: candidate.decisionRecordedAt,
          current_router_marker: candidate.currentMarker,
          current_router_confidence: candidate.currentConfidence,
          historical_marker: candidate.historicalMarker,
          evaluation_status: assessment.ok
            ? (assessment.abstained ? "abstained" : (assessment.parity ? "parity" : "mismatch"))
            : "invalid_response",
          jev_model: assessment.model,
          jev_marker: assessment.derivedMarker,
          parity: assessment.parity,
          abstained: assessment.abstained,
          abstention_reason: assessment.abstentionReason,
          facts: assessment.facts,
          confidence: assessment.confidence,
          usage: assessment.usage,
          duration_ms: result.duration_ms,
          ...(assessment.ok ? {} : { error: assessment.reason }),
        };
      };

      for (let index = 0; index < selected.length; index += concurrency) {
        const chunk = selected.slice(index, index + concurrency);
        results.push(...await Promise.all(chunk.map((candidate) => evaluateOne(candidate))));
      }

      const parity = results.filter((item) => item.evaluation_status === "parity").length;
      const mismatch = results.filter((item) => item.evaluation_status === "mismatch").length;
      const abstained = results.filter((item) => item.evaluation_status === "abstained").length;
      const failed = results.length - parity - mismatch - abstained;
      const direct = parity + mismatch;
      const durations = results
        .map((item) => typeof item.duration_ms === "number" ? item.duration_ms : null)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b);
      const inputTokens = results
        .map((item) => readUsageNumber(item, "inputTokens"))
        .filter((value): value is number => value !== null);
      const outputTokens = results
        .map((item) => readUsageNumber(item, "outputTokens"))
        .filter((value): value is number => value !== null);

      return textResult({
        ok: failed === 0,
        status: failed === 0 ? "JEV_HISTORY_EVALUATION_COMPLETED" : "JEV_HISTORY_EVALUATION_PARTIAL_FAILURE",
        semantic_contract: "independent-shadow-v2",
        historical_pair_count: candidates.length,
        selected_case_count: selected.length,
        current_router_marker_counts: countMarkers(candidates),
        metrics: {
          parity,
          mismatch,
          abstained,
          failed,
          direct,
          direct_coverage: results.length === 0 ? 0 : Number((direct / results.length).toFixed(4)),
          direct_accuracy: direct === 0 ? null : Number((parity / direct).toFixed(4)),
          wrong_promoted: mismatch,
          wall_duration_ms: Date.now() - startedAt,
          latency_ms: {
            p50: percentile(durations, 0.5),
            p95: percentile(durations, 0.95),
          },
          usage: {
            input_tokens_total: inputTokens.reduce((sum, value) => sum + value, 0),
            output_tokens_total: outputTokens.reduce((sum, value) => sum + value, 0),
          },
        },
        results,
      });
    },
  );
}

function collectHistoricalCandidates(raw: string): HistoricalCandidate[] {
  const latestCaptureByTask = new Map<string, {
    eventId: string | null;
    ts: string | null;
    text: string;
  }>();
  const candidates: HistoricalCandidate[] = [];

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) continue;
      event = parsed;
    } catch {
      continue;
    }

    const taskId = stringValue(event.task_id);
    if (!taskId) continue;
    const eventName = stringValue(event.event);

    if (eventName === "executor_answer_captured") {
      const data = recordValue(event.data);
      const latestAssistant = recordValue(data.latest_assistant);
      const text = stringValue(latestAssistant.text);
      if (!text) continue;
      latestCaptureByTask.set(taskId, {
        eventId: stringValue(event.event_id),
        ts: stringValue(event.ts),
        text,
      });
      continue;
    }

    if (eventName !== "engine_decision_recorded") continue;
    const capture = latestCaptureByTask.get(taskId);
    if (!capture) continue;

    const data = recordValue(event.data);
    const historicalMarker = stringValue(data.decision_status)
      ?? stringValue(data.marker)
      ?? stringValue(data.status);
    const current = classifyActionMarkerFromText(capture.text);
    if (!SEMANTIC_MARKERS.has(current.marker)) continue;

    candidates.push({
      taskId,
      captureEventId: capture.eventId,
      decisionEventId: stringValue(event.event_id),
      capturedAt: capture.ts,
      decisionRecordedAt: stringValue(data.decision_recorded_at) ?? stringValue(event.ts),
      answer: capture.text,
      currentMarker: current.marker,
      currentConfidence: current.confidence,
      historicalMarker,
    });
  }

  return candidates;
}

function selectBalancedCandidates(
  candidates: HistoricalCandidate[],
  samplePerMarker: number,
  maxCases: number,
): HistoricalCandidate[] {
  const sorted = [...candidates].sort((a, b) =>
    String(b.decisionRecordedAt ?? "").localeCompare(String(a.decisionRecordedAt ?? "")),
  );
  const counts = new Map<ActionMarker, number>();
  const selected: HistoricalCandidate[] = [];

  for (const candidate of sorted) {
    if (selected.length >= maxCases) break;
    const count = counts.get(candidate.currentMarker) ?? 0;
    if (count >= samplePerMarker) continue;
    counts.set(candidate.currentMarker, count + 1);
    selected.push(candidate);
  }

  return selected;
}

function countMarkers(candidates: HistoricalCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    counts[candidate.currentMarker] = (counts[candidate.currentMarker] ?? 0) + 1;
  }
  return counts;
}

function readUsageNumber(item: Record<string, unknown>, key: "inputTokens" | "outputTokens"): number | null {
  const usage = recordValue(item.usage);
  return typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] : null;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
  return values[index] ?? null;
}

function compact(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 1000 ? normalized : `${normalized.slice(0, 1000)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
