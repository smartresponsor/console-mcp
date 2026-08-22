export type ActionMarker =
  | "continue"
  | "next"
  | "go"
  | "do it"
  | "commit"
  | "commit and continue"
  | "commit and next"
  | "fix fail and continue"
  | "fix fail and go"
  | "fix fail and next"
  | "fix fail and commit"
  | "fix fail, commit and continue"
  | "fix blocker and continue"
  | "recheck and continue"
  | "human decision required"
  | "done";

export type ActionMarkerRouterResult = {
  status: ActionMarker;
  marker: ActionMarker;
  next_action: string;
  summary: string;
  confidence: number;
  route: "direct";
  source: "action_marker_router";
  ask_required: false;
  reply_back_required: boolean;
  signals: Record<string, number>;
  praise: string[];
  correction: string[];
  matched: string[];
};

const ACTION_MARKERS: ActionMarker[] = [
  "continue",
  "next",
  "go",
  "do it",
  "commit",
  "commit and continue",
  "commit and next",
  "fix fail and continue",
  "fix fail and go",
  "fix fail and next",
  "fix fail and commit",
  "fix fail, commit and continue",
  "fix blocker and continue",
  "recheck and continue",
  "human decision required",
  "done",
];

const NON_TERMINAL_MARKERS = new Set<ActionMarker>(ACTION_MARKERS.filter((marker) => marker !== "done" && marker !== "human decision required"));

const SIGNAL_PATTERNS: Record<string, RegExp[]> = {
  fail: [
    /\bFAIL(?:ED|ING)?\b/i,
    /\bfail(?:ed|ing|ure)?\b/i,
    /\berror\b/i,
    /\binvalid\b/i,
    /\bincomplete\b/i,
    /\bfailed\s+gate\b/i,
    /\bexit\s+code\s*[1-9]\d*\b/i,
  ],
  blocker: [
    /\bblocker\b/i,
    /\bblocked\b/i,
    /\bcannot\s+proceed\b/i,
    /\bcan't\s+proceed\b/i,
  ],
  gate: [
    /\bcomposer\s+qa\b/i,
    /\bphpunit\b/i,
    /\bphpstan\b/i,
    /\blint\b/i,
    /\btest(?:s)?\b/i,
    /\bgate(?:s)?\b/i,
  ],
  dirty: [
    /\bdirty\s+(?:worktree|workspace|tree)\b/i,
    /\buncommitted\b/i,
    /\bnot\s+committed\b/i,
    /\bcommit\s+needed\b/i,
    /\bneeds?\s+commit\b/i,
  ],
  commit: [
    /\bcommit\s+(?:created|made|done|exists|recorded)\b/i,
    /\bcommitted\b/i,
    /\bsigned\s+commit\b/i,
    /\bcommit:\s*[a-f0-9]{7,40}\b/i,
    /\b[a-f0-9]{7,40}\s+[—-]\s+/i,
  ],
  clean: [
    /\bworkspace\s+clean\b/i,
    /\bworktree\s+clean\b/i,
    /\bgit\s+status\s+clean\b/i,
    /\bnothing\s+to\s+commit\b/i,
  ],
  green: [
    /\bPASS(?:ED)?\b/i,
    /\bgreen\b/i,
    /\bok\b/i,
    /\bsuccess(?:ful)?\b/i,
    /\bgates?\s+green\b/i,
  ],
  next: [
    /\bnext\s+(?:action|step|iteration)\b/i,
    /\bcontinue\s+(?:with|to)\b/i,
    /\bgo\s+next\b/i,
  ],
  question: [
    /\?/, 
    /\bwhich\s+(?:option|one)\b/i,
    /\bwhat\s+should\b/i,
    /\bshould\s+i\b/i,
    /\bdo\s+you\s+want\b/i,
    /\bplease\s+confirm\b/i,
    /\boption\s+[12ab]\b/i,
    /\b(?:a|1)\s+or\s+(?:b|2)\b/i,
  ],
  human: [
    /^(?:status\s*[:=-]\s*)?human\s+(?:decision|input|approval)\s+required[.!]?\s*$/im,
    /\bhuman\s+(?:decision|input|approval)\s+is\s+required\b/i,
    /\brequires?\s+(?:a\s+)?human\s+(?:decision|input|approval)\b/i,
    /^(?:status\s*[:=-]\s*)?user\s+(?:decision|input|approval)\s+required[.!]?\s*$/im,
    /\buser\s+(?:decision|input|approval)\s+is\s+required\b/i,
    /\brequires?\s+(?:the\s+)?user(?:'s)?\s+(?:decision|input|approval)\b/i,
    /\bproduct\s+decision\s+is\s+required\b/i,
    /\brequires?\s+(?:a\s+)?product\s+decision\b/i,
    /\barchitectural\s+decision\s+is\s+required\b/i,
    /\brequires?\s+(?:an\s+)?architectural\s+decision\b/i,
    /\bneed(?:s|ed)?\s+(?:the\s+)?user(?:'s)?\s+(?:decision|input|approval)\b/i,
    /\brequires?\s+(?:explicit\s+)?approval\b/i,
    /\bcannot\s+safely\s+(?:choose|decide|proceed)\b/i,
  ],
  done: [
    /\boriginal\s+(?:specification|task|scope)\s+(?:is\s+)?(?:complete|completed|done)\b/i,
    /\ball\s+(?:requested\s+)?(?:scope|work|items)\s+(?:is\s+)?(?:complete|completed|done)\b/i,
    /\bno\s+remaining\s+(?:work|items|tasks|action)\b/i,
    /\btask\s+(?:is\s+)?(?:complete|completed|done)\b/i,
  ],
};

const NEGATED_FAIL_PATTERNS = [
  /\bno\s+fails?\b/i,
  /\bno\s+failures?\b/i,
  /\bwithout\s+failures?\b/i,
  /\bno\s+errors?\b/i,
];

const RESOLVED_FAIL_LINE_PATTERNS = [
  /\b(?:fail|failure|error|blocker)\b.{0,48}\b(?:fixed|resolved|repaired|closed|cleared|eliminated|gone)\b/i,
  /\b(?:fixed|resolved|repaired|closed|cleared|eliminated)\b.{0,48}\b(?:fail|failure|error|blocker)\b/i,
  /\b(?:fail|failure|error|blocker)\b.{0,48}(?:исправлен|исправлена|исправлено|устран[её]н|устранена|устранено|закрыт|закрыта|закрыто)/iu,
  /(?:исправлен|исправлена|исправлено|устран[её]н|устранена|устранено|закрыт|закрыта|закрыто).{0,48}\b(?:fail|failure|error|blocker)\b/iu,
  /\bfail[- ]closed\b/i,
  /\bfalse\s+settle\s+(?:fixed|resolved|eliminated|устран[её]н)\b/iu,
];

export function classifyActionMarkerFromText(text: string): ActionMarkerRouterResult {
  const normalizedText = text.trim();
  const signals = collectSignals(normalizedText);
  const praise = buildPraise(signals);
  const matched = collectMatchedLines(normalizedText);
  const correction: string[] = [];
  const hasFail = signals.fail > 0;
  const hasBlocker = signals.blocker > 0;
  const hasDirty = signals.dirty > 0;
  const hasCommit = signals.commit > 0;
  const hasGreen = signals.green > 0;
  const hasNext = signals.next > 0;
  const hasQuestion = signals.question > 0;
  const hasHuman = signals.human > 0;
  const hasDone = signals.done > 0;
  let marker: ActionMarker;
  let confidence = 0.6;

  if (normalizedText === "") {
    marker = "recheck and continue";
    correction.push("Recheck the executor answer because no usable report text was captured.");
    confidence = 0.78;
  } else if (hasHuman) {
    marker = "human decision required";
    correction.push("Stop autonomous execution and return a concise decision packet to the user; do not guess across a product, architecture, policy, or approval boundary.");
    confidence = 0.96;
  } else if (hasFail && hasDirty) {
    marker = "fix fail, commit and continue";
    correction.push("Fix the reported fail, rerun relevant verification until green, create a coherent commit, then continue the original execution specification while budget remains.");
    confidence = 0.94;
  } else if (hasFail) {
    marker = "fix fail and continue";
    correction.push("Fix the reported fail, rerun relevant verification until green, create a coherent commit if files changed, then continue the original execution specification while budget remains.");
    confidence = hasCommit || signals.gate > 0 ? 0.92 : 0.86;
  } else if (hasBlocker) {
    marker = "fix blocker and continue";
    correction.push("Fix the reported blocker, verify the affected path, commit if files changed, then continue the original execution specification while budget remains.");
    confidence = 0.84;
  } else if (hasQuestion) {
    marker = "recheck and continue";
    correction.push("Resolve the executor question into a concrete next bounded action without stopping the budget loop.");
    confidence = 0.74;
  } else if (hasDone && hasGreen && signals.clean > 0 && hasCommit) {
    marker = "done";
    correction.push("No further action is required if the original execution specification is fully complete.");
    confidence = 0.91;
  } else if (hasGreen && hasNext) {
    marker = "next";
    correction.push("Continue with the reported next bounded step while budget remains.");
    confidence = 0.86;
  } else if (hasGreen) {
    marker = "continue";
    correction.push("Continue the original execution specification; local green is good but is not automatically full task completion.");
    confidence = 0.8;
  } else if (hasCommit) {
    marker = "commit and continue";
    correction.push("Preserve the committed progress and continue with the next unfinished bounded step while budget remains.");
    confidence = 0.78;
  } else {
    marker = "recheck and continue";
    correction.push("Recheck the report, identify the next concrete bounded action, and continue without asking the user for approval.");
    confidence = 0.66;
  }

  const summary = summarize(marker, signals);
  const nextAction = buildNextAction(praise, correction);

  return {
    status: marker,
    marker,
    next_action: nextAction,
    summary,
    confidence,
    route: "direct",
    source: "action_marker_router",
    ask_required: false,
    reply_back_required: marker !== "done" && marker !== "human decision required",
    signals,
    praise,
    correction,
    matched,
  };
}

export function normalizeActionMarker(value: unknown): ActionMarker | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[_.-]+/g, " ").replace(/\s+/g, " ");
  if ((ACTION_MARKERS as string[]).includes(normalized)) return normalized as ActionMarker;
  return matchLegacyDecisionStatus(normalized);
}

export function isTerminalActionMarker(value: unknown): boolean {
  return normalizeActionMarker(value) === "done";
}

export function isContinuingActionMarker(value: unknown): boolean {
  const marker = normalizeActionMarker(value);
  return marker !== null && NON_TERMINAL_MARKERS.has(marker);
}

export function isHumanDecisionActionMarker(value: unknown): boolean {
  return normalizeActionMarker(value) === "human decision required";
}

export function buildActionMarkerReplyBackText(taskId: string, task: Record<string, unknown>): string {
  const marker = normalizeActionMarker(task.decision_status) ?? "recheck and continue";
  const readOnly = task.mutation_policy === "read_only";
  const next = readOnly
    ? "Continue with read-only verification of the reported state. Do not modify, stage, commit, reset, clean, delete, rename, or generate repository files. If a defect is found, report it as an unresolved technical finding rather than fixing it in this run."
    : (typeof task.decision_next_action === "string" && task.decision_next_action.trim() !== ""
      ? task.decision_next_action.trim()
      : "Recheck the latest executor report, choose the next bounded action, and continue the loop without asking for approval.");
  const lines = [`Decision: ${marker}.`, "", next];
  if (marker === "human decision required") {
    lines.push("", "Stop autonomous execution and return the unresolved decision to the user without choosing on their behalf.");
  } else if (marker !== "done") {
    lines.push("", readOnly
      ? "Continue the original read-only execution specification with the next unfinished verification step while budget remains. Repository mutation remains forbidden for every continuation round."
      : "Continue the original execution specification with the next unfinished bounded step while budget remains.");
  } else {
    lines.push("", "Stop only if the original execution specification is fully complete and all required verification is green.");
  }
  lines.push("", readOnly
    ? "Return concise status, observed repository state, gates run, no repository changes, no commit, and next action."
    : "Return concise status, changed files, gates run, commit created, and next action.");
  return lines.join("\n");
}

function collectSignals(text: string): Record<string, number> {
  const signals: Record<string, number> = Object.fromEntries(Object.keys(SIGNAL_PATTERNS).map((key) => [key, 0]));
  for (const [name, patterns] of Object.entries(SIGNAL_PATTERNS)) {
    if (name === "fail") {
      const activeFailLines = text.split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !RESOLVED_FAIL_LINE_PATTERNS.some((pattern) => pattern.test(line)));
      signals[name] = patterns.reduce((count, pattern) => count + activeFailLines.reduce((lineCount, line) => lineCount + countMatches(line, pattern), 0), 0);
      continue;
    }
    signals[name] = patterns.reduce((count, pattern) => count + countMatches(text, pattern), 0);
  }
  if (signals.fail > 0 && NEGATED_FAIL_PATTERNS.some((pattern) => pattern.test(text))) signals.fail = 0;
  return signals;
}

function countMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  return Array.from(text.matchAll(new RegExp(pattern.source, flags))).length;
}

function buildPraise(signals: Record<string, number>): string[] {
  const praise: string[] = [];
  if (signals.commit > 0) praise.push("Commit is good.");
  if (signals.clean > 0) praise.push("Workspace clean is good.");
  if (signals.green > 0) praise.push("Green gates are good.");
  if (signals.next > 0) praise.push("Clear next action is good.");
  return praise.slice(0, 3);
}

function collectMatchedLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.filter((line) => Object.values(SIGNAL_PATTERNS).flat().some((pattern) => pattern.test(line))).slice(0, 12);
}

function summarize(marker: ActionMarker, signals: Record<string, number>): string {
  const activeSignals = Object.entries(signals).filter(([, count]) => count > 0).map(([name, count]) => `${name}:${count}`).join(", ");
  return `Action marker router selected '${marker}' from signals: ${activeSignals || "none"}.`;
}

function buildNextAction(praise: string[], correction: string[]): string {
  const lines: string[] = [];
  if (praise.length > 0) lines.push(`Good: ${praise.join(" ")}`);
  if (correction.length > 0) lines.push(`Action: ${correction.join(" ")}`);
  return lines.length > 0 ? lines.join("\n") : "Action: recheck and continue.";
}

function matchLegacyDecisionStatus(value: string): ActionMarker | null {
  switch (value) {
    case "green":
    case "continue":
    case "allow":
    case "correct and continue":
    case "attention":
    case "go next":
      return "continue";
    case "do fix":
    case "red":
      return "fix fail and continue";
    case "recheck":
    case "wait":
    case "retry":
      return "recheck and continue";
    case "complete":
    case "completed":
    case "task done":
      return "done";
    default:
      return null;
  }
}
