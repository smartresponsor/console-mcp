import type { ActionMarker } from "./action-marker-router.js";

export const JEV_SHADOW_CONTRACT_VERSION = "2" as const;

export type JevQuestionType = "noul" | "choice" | "score";

export type JevDecisionInput = {
  state: {
    executor_answer: string;
    mutation_policy?: string;
    git_commit_policy?: string;
    git_push_policy?: string;
    scope: "console_mcp_engine_decision_shadow";
    authority: "shadow_only";
    semantic_contract_version: typeof JEV_SHADOW_CONTRACT_VERSION;
  };
  questions: Record<string, {
    type: JevQuestionType;
    instructions: string;
    criteria?: Record<string, string> | string[];
  }>;
};

export type JevNoulAnswer = {
  type: "noul";
  noul: number;
};

export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

export type JevScoreAnswer = {
  type: "score";
  score: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
};

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export type JevDecisionResponse = {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

export type JevShadowSemanticFacts = {
  activeFailure: number;
  activeBlocker: number;
  humanDecisionRequired: number;
  taskCompleteClaimed: number;
  repositoryProgress: "none" | "diff_created" | "commit_created" | "verified_green" | null;
  continuationIntent: "continue" | "next" | "recheck" | "finish" | null;
};

export type JevShadowChoiceConfidence = {
  repositoryProgress: number | null;
  continuationIntent: number | null;
};

export type JevShadowAssessment = {
  ok: boolean;
  model: string | null;
  facts: JevShadowSemanticFacts | null;
  confidence: JevShadowChoiceConfidence | null;
  derivedMarker: ActionMarker | null;
  parity: boolean | null;
  abstained: boolean;
  abstentionReason: string | null;
  reason: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
};

const ENGINE_SHADOW_QUESTIONS: JevDecisionInput["questions"] = {
  active_failure: {
    type: "noul",
    instructions: "Did a currently executed command, test, validation, gate, or implementation operation produce an active unresolved failing result in executor_answer?",
    criteria: {
      true: "A command, test, validation, gate, or operation actually ran and currently reports FAIL, error, invalid output, or another unresolved failing result.",
      false: "Failures are absent, historical, negated, explicitly resolved, or the relevant check did not run because runtime capacity, infrastructure, permissions, tooling, or another blocker prevented execution.",
    },
  },
  active_blocker: {
    type: "noul",
    instructions: "Is there an active unresolved blocker that prevents the next safe execution step?",
    criteria: {
      true: "A current unresolved blocker prevents the next step, including runtime capacity, infrastructure, permissions, unavailable tooling, unresolved ownership, or another execution precondition.",
      false: "No current blocker is present, or the mentioned blocker is historical or explicitly resolved.",
    },
  },
  human_decision_required: {
    type: "noul",
    instructions: "Does continuation require a genuine product, architecture, policy, ownership, or approval choice that cannot be resolved from the existing specification and policy without human authority?",
    criteria: {
      true: "There are materially valid alternatives or an ownership/approval boundary and choosing one requires human authority rather than technical diagnosis.",
      false: "The next action can be determined from repository evidence, current specification, existing policy, or further technical verification; merely saying that a decision or further analysis is needed is not enough.",
    },
  },
  task_complete_claimed: {
    type: "noul",
    instructions: "Does the report claim that the original task or specification is fully complete?",
    criteria: {
      true: "The original requested scope is explicitly claimed complete with no remaining work.",
      false: "Only a local step is complete, or remaining work or failure exists.",
    },
  },
  repository_progress: {
    type: "choice",
    instructions: "What is the strongest repository progress explicitly evidenced by executor_answer?",
    criteria: {
      none: "No diff, commit, or verified green progress is evidenced.",
      diff_created: "Working tree changes are reported but no commit is evidenced.",
      commit_created: "A commit is explicitly evidenced.",
      verified_green: "Required verification is explicitly green without an active failure.",
    },
  },
  continuation_intent: {
    type: "choice",
    instructions: "What continuation state best matches executor_answer?",
    criteria: {
      continue: "Proceed with the original task after handling any bounded technical issue.",
      next: "The current bounded step is complete and the next bounded step should begin.",
      recheck: "Evidence is insufficient or contradictory and should be rechecked.",
      finish: "The report proposes full completion of the original task.",
    },
  },
};

export function buildJevEngineShadowInput(
  executorAnswer: string,
  task: Record<string, unknown>,
): JevDecisionInput {
  return {
    state: {
      executor_answer: executorAnswer,
      mutation_policy: optionalString(task.mutation_policy),
      git_commit_policy: optionalString(task.git_commit_policy),
      git_push_policy: optionalString(task.git_push_policy),
      scope: "console_mcp_engine_decision_shadow",
      authority: "shadow_only",
      semantic_contract_version: JEV_SHADOW_CONTRACT_VERSION,
    },
    questions: ENGINE_SHADOW_QUESTIONS,
  };
}

export function assessJevEngineShadowResponse(
  value: unknown,
  deterministicMarker: ActionMarker,
): JevShadowAssessment {
  const parsed = parseResponse(value);
  if (parsed === null) {
    return unavailable("Jev response is missing or malformed.");
  }

  const activeFailure = readNoul(parsed.answers.active_failure);
  const activeBlocker = readNoul(parsed.answers.active_blocker);
  const humanDecisionRequired = readNoul(parsed.answers.human_decision_required);
  const taskCompleteClaimed = readNoul(parsed.answers.task_complete_claimed);
  const repositoryProgressAnswer = readChoice(parsed.answers.repository_progress, ["none", "diff_created", "commit_created", "verified_green"] as const);
  const continuationIntentAnswer = readChoice(parsed.answers.continuation_intent, ["continue", "next", "recheck", "finish"] as const);

  if (
    activeFailure === null
    || activeBlocker === null
    || humanDecisionRequired === null
    || taskCompleteClaimed === null
    || repositoryProgressAnswer === null
    || continuationIntentAnswer === null
  ) {
    return unavailable("Jev response does not satisfy the required semantic answer contract.", parsed.model);
  }

  const facts: JevShadowSemanticFacts = {
    activeFailure,
    activeBlocker,
    humanDecisionRequired,
    taskCompleteClaimed,
    repositoryProgress: repositoryProgressAnswer.choice,
    continuationIntent: continuationIntentAnswer.choice,
  };
  const confidence: JevShadowChoiceConfidence = {
    repositoryProgress: repositoryProgressAnswer.confidence,
    continuationIntent: continuationIntentAnswer.confidence,
  };
  const derivation = protectDeterministicBoundary(
    deterministicMarker,
    deriveJevSemanticMarker(facts, confidence),
  );

  return {
    ok: true,
    model: typeof parsed.model === "string" ? parsed.model : null,
    facts,
    confidence,
    derivedMarker: derivation.marker,
    parity: derivation.marker === null ? null : derivation.marker === deterministicMarker,
    abstained: derivation.marker === null,
    abstentionReason: derivation.reason,
    reason: derivation.marker === null
      ? "Structured Jev shadow response parsed successfully and abstained on low-confidence continuation intent."
      : "Structured Jev shadow response parsed successfully.",
    usage: {
      inputTokens: finiteNumber(parsed.usage?.input_tokens),
      outputTokens: finiteNumber(parsed.usage?.output_tokens),
    },
  };
}

function protectDeterministicBoundary(
  deterministicMarker: ActionMarker,
  derivation: { marker: ActionMarker | null; reason: string | null },
): { marker: ActionMarker | null; reason: string | null } {
  if (derivation.marker === null) return derivation;

  if (
    (deterministicMarker === "human decision required" || deterministicMarker === "done")
    && derivation.marker !== deterministicMarker
  ) {
    return {
      marker: null,
      reason: `deterministic terminal boundary '${deterministicMarker}' remains authoritative`,
    };
  }

  if (
    derivation.marker !== deterministicMarker
    && (isCorrectiveMarker(derivation.marker) || isCorrectiveMarker(deterministicMarker))
  ) {
    return {
      marker: null,
      reason: `non-terminal corrective disagreement remains shadow-only: deterministic='${deterministicMarker}', jev='${derivation.marker}'`,
    };
  }

  return derivation;
}

function isCorrectiveMarker(marker: ActionMarker): boolean {
  return marker === "fix fail and continue"
    || marker === "fix fail, commit and continue"
    || marker === "fix blocker and continue";
}

export function deriveJevSemanticMarker(
  facts: JevShadowSemanticFacts,
  confidence: JevShadowChoiceConfidence,
): { marker: ActionMarker | null; reason: string | null } {
  if (facts.humanDecisionRequired >= 0.6) return { marker: "human decision required", reason: null };
  if (facts.activeFailure >= 0.6) return { marker: "fix fail and continue", reason: null };
  if (facts.activeBlocker >= 0.5) return { marker: "fix blocker and continue", reason: null };

  const continuationConfidence = confidence.continuationIntent;
  if (continuationConfidence === null || continuationConfidence < 0.75) {
    return { marker: null, reason: "continuation_intent confidence is below the 0.75 shadow threshold" };
  }

  if (facts.taskCompleteClaimed >= 0.5 && facts.continuationIntent === "finish") return { marker: "done", reason: null };
  if (facts.continuationIntent === "recheck") return { marker: "recheck and continue", reason: null };
  if (facts.continuationIntent === "next") return { marker: "next", reason: null };
  return { marker: "continue", reason: null };
}

function parseResponse(value: unknown): JevDecisionResponse | null {
  if (!isRecord(value)) return null;

  const first = isRecord(value.result) ? value.result : value;
  const candidate = isRecord(first.result) ? first.result : first;

  if (!isRecord(candidate.answers)) return null;
  return candidate as unknown as JevDecisionResponse;
}

function readNoul(value: unknown): number | null {
  if (!isRecord(value) || value.type !== "noul") return null;
  const score = finiteNumber(value.noul);
  if (score === null || score < 0 || score > 1) return null;
  return score;
}

function readChoice<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): { choice: T[number]; confidence: number | null } | null {
  if (!isRecord(value) || value.type !== "choice" || typeof value.choice !== "string") return null;
  if (!(allowed as readonly string[]).includes(value.choice)) return null;
  const confidence = finiteNumber(value.confidence);
  return {
    choice: value.choice as T[number],
    confidence: confidence !== null && confidence >= 0 && confidence <= 1 ? confidence : null,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(reason: string, model?: unknown): JevShadowAssessment {
  return {
    ok: false,
    model: typeof model === "string" ? model : null,
    facts: null,
    confidence: null,
    derivedMarker: null,
    parity: null,
    abstained: false,
    abstentionReason: null,
    reason,
    usage: {
      inputTokens: null,
      outputTokens: null,
    },
  };
}
