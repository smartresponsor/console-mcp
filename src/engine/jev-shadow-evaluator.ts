import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { executeAsk } from "../tool/ask.js";
import type { ActionMarkerRouterResult } from "./action-marker-router.js";
import {
  assessJevEngineShadowResponse,
  buildJevEngineShadowInput,
  JEV_SHADOW_CONTRACT_VERSION,
} from "./jev-shadow-contract.js";

export async function evaluateJevShadow(input: {
  policy: ConsolePolicy;
  baseDir: string;
  workspacePath: string;
  executorAnswer: string;
  deterministic: ActionMarkerRouterResult;
  task: Record<string, unknown>;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const request = buildJevEngineShadowInput(
    input.executorAnswer,
    input.task,
  );

  const result = await executeAsk(
    input.policy,
    input.baseDir,
    input.workspacePath,
    JSON.stringify(request),
    "typesafe/jev",
    256,
    0,
    Math.max(5000, Math.min(60000, input.timeoutMs)),
    false,
    "http://127.0.0.1:3334/mcp",
  );

  if (!result.ok || !result.stdout_json_parse_ok) {
    return {
      enabled: true,
      attempted: true,
      status: "failed",
      duration_ms: result.duration_ms,
      error: result.stderr.slice(0, 1000),
    };
  }

  const assessment = assessJevEngineShadowResponse(
    result.stdout_json,
    input.deterministic.marker,
  );

  return {
    enabled: true,
    attempted: true,
    semantic_contract_version: JEV_SHADOW_CONTRACT_VERSION,
    status: assessment.ok ? "completed" : "failed",
    duration_ms: result.duration_ms,
    model: assessment.model,
    parity: assessment.parity,
    derived_marker: assessment.derivedMarker,
    abstained: assessment.abstained,
    abstention_reason: assessment.abstentionReason,
    facts: assessment.facts,
    confidence: assessment.confidence,
    usage: assessment.usage,
    error: assessment.ok ? null : assessment.reason,
  };
}
