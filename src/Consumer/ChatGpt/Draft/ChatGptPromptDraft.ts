import { hashChatGptArtifactText } from "../../../service/chatgpt-artifact-guard.js";
import type { BrowserSessionOptions, ChatGptTarget } from "../../../service/browser-session-executor.js";
import { verifyDraft } from "./ChatGptDraftVerifier.js";

type TargetSelection = {
  ok: boolean;
  status: string;
  target: ChatGptTarget | null;
  inventory_summary?: Record<string, unknown>;
  candidate_rejections?: unknown;
  selected_target_candidates?: unknown;
};

type PromptDraftDependencies = {
  resolveTarget: (input: BrowserSessionOptions) => Promise<TargetSelection>;
  readInputSnapshot: (target: ChatGptTarget, timeoutMs?: number) => Promise<Record<string, unknown>>;
  safeEvaluateInTarget: (webSocketUrl: string, expression: string, timeoutMs: number, failureStatus: string) => Promise<unknown>;
  safeSendDevToolsCommand: (webSocketUrl: string, method: string, params: Record<string, unknown>, timeoutMs: number, failureStatus: string) => Promise<Record<string, unknown>>;
  buildComposerFocusExpression: (allowOverwrite: boolean) => string;
  compactChatGptTarget: (target: ChatGptTarget) => Record<string, unknown>;
  redactInputSnapshot: (snapshot: unknown, draftHash: string | null) => Record<string, unknown>;
  normalizeTimeout: (value: unknown) => number;
};

export function createChatGptPromptDraft(deps: PromptDraftDependencies) {
  async function draftInput(input: BrowserSessionOptions & { prompt: string }): Promise<Record<string, unknown>> {
    const selected = await deps.resolveTarget(input);
    if (!selected.ok || !selected.target) return { ...selected, ok: false, status: "INPUT_DRAFT_TARGET_NOT_READY" };
    const target = selected.target;
    if (!target.web_socket_debugger_url) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", selected: deps.compactChatGptTarget(target), submitted: false };
    const before = await deps.readInputSnapshot(target, input.timeoutMs);
    const beforeText = typeof before.text === "string" ? before.text : "";
    const normalizedBeforeText = normalizeComposerOwnershipText(beforeText);
    const beforeHash = normalizedBeforeText.length > 0 ? hashChatGptArtifactText(normalizedBeforeText) : null;
    if (input.allowOverwrite === true && input.expectedExistingHash && beforeHash !== input.expectedExistingHash) {
      return {
        ok: false,
        status: "COMPOSER_COMPARE_AND_REPLACE_REJECTED",
        target_id: target.id ?? null,
        port: target.port,
        expected_existing_hash: input.expectedExistingHash,
        current_existing_hash: beforeHash,
        existing_length: beforeText.length,
        selected: deps.compactChatGptTarget(target),
        input_snapshot: deps.redactInputSnapshot(before, beforeHash),
        submitted: false,
      };
    }
    if (beforeText.trim().length > 0 && input.allowOverwrite !== true) {
      const existingVerification = verifyDraft(input.prompt, beforeText);
      const compactExpected = input.prompt.replace(/\s+/gu, " ").trim();
      const compactActual = beforeText.replace(/\s+/gu, " ").trim();
      const nearSerializedMatch = Math.abs(beforeText.length - input.prompt.length) <= 4
        && compactExpected.slice(0, 120) === compactActual.slice(0, 120)
        && compactExpected.slice(-120) === compactActual.slice(-120);
      if (existingVerification.draft_verification !== "MISMATCH" || existingVerification.mismatch_classification === "whitespace_only" || existingVerification.mismatch_classification === "newline_only" || nearSerializedMatch) {
        return {
          ok: true,
          status: "INPUT_DRAFT_ALREADY_PRESENT",
          target_id: target.id ?? null,
          port: target.port,
          selected: deps.compactChatGptTarget(target),
          draft_verification: existingVerification.draft_verification,
          verification: existingVerification,
          expected_length: existingVerification.expected_length,
          actual_length: existingVerification.actual_length,
          normalized_expected_length: existingVerification.normalized_expected_length,
          normalized_actual_length: existingVerification.normalized_actual_length,
          mismatch_classification: existingVerification.mismatch_classification,
          draft_hash: hashChatGptArtifactText(beforeText),
          draft_length: beforeText.length,
          input_snapshot: deps.redactInputSnapshot(before, hashChatGptArtifactText(beforeText)),
          submitted: false,
        };
      }
      return { ok: false, status: "COMPOSER_NOT_EMPTY", selected: deps.compactChatGptTarget(target), input_snapshot: deps.redactInputSnapshot(before, null), submitted: false };
    }
    const focus = await deps.safeEvaluateInTarget(target.web_socket_debugger_url, deps.buildComposerFocusExpression(input.allowOverwrite === true), deps.normalizeTimeout(input.timeoutMs), "INPUT_FOCUS_EVALUATION_FAILED");
    if (asRecord(focus).ok !== true) {
      return { ok: false, status: "INPUT_FOCUS_BLOCKED", target_id: target.id ?? null, port: target.port, selected: deps.compactChatGptTarget(target), focus, submitted: false };
    }
    const textInsert = await deps.safeSendDevToolsCommand(target.web_socket_debugger_url, "Input.insertText", { text: input.prompt }, deps.normalizeTimeout(input.timeoutMs), "INPUT_INSERT_TEXT_FAILED");
    const draft = { ok: asRecord(textInsert).ok === true, status: asRecord(textInsert).ok === true ? "DRAFT_SET" : "DRAFT_WRITE_NOT_APPLIED", draftLength: input.prompt.length, existingLength: beforeText.length, afterLength: input.prompt.length, activeLength: input.prompt.length, afterText: input.prompt, activeText: input.prompt, targetTag: asRecord(focus).targetTag ?? null, targetClass: asRecord(focus).targetClass ?? null, activeTag: asRecord(focus).activeTag ?? null, readyState: asRecord(focus).readyState ?? null, href: asRecord(focus).href ?? null, title: asRecord(focus).title ?? null, focus, textInsert };
    const after = await deps.readInputSnapshot(target, input.timeoutMs);
    const draftRecord = asRecord(draft);
    // Only the post-write DOM snapshot is authoritative. The draft object's activeText/afterText
    // fields echo the requested prompt and cannot prove where CDP Input.insertText actually landed.
    const actual = typeof after.text === "string" ? after.text : "";
    const verification = verifyDraft(input.prompt, actual);
    const lengthDelta = Math.abs(actual.length - input.prompt.length);
    const cdpNearMatch = asRecord(draftRecord.textInsert).ok === true && actual.length > 0 && lengthDelta <= 32;
    const ok = draftRecord.ok === true && actual.length > 0 && (verification.draft_verification !== "MISMATCH" || cdpNearMatch);
    return {
      ok,
      status: ok ? "INPUT_DRAFT_WRITTEN" : (verification.mismatch_classification === "content_changed" ? "INPUT_DRAFT_CONTENT_CHANGED" : "INPUT_DRAFT_BLOCKED"),
      target_id: target.id ?? null,
      port: target.port,
      selected: deps.compactChatGptTarget(target),
      draft,
      draft_verification: verification.draft_verification,
      verification,
      expected_length: verification.expected_length,
      actual_length: verification.actual_length,
      normalized_expected_length: verification.normalized_expected_length,
      normalized_actual_length: verification.normalized_actual_length,
      mismatch_classification: verification.mismatch_classification,
      draft_hash: hashChatGptArtifactText(input.prompt),
      draft_length: input.prompt.length,
      input_snapshot: deps.redactInputSnapshot(after, hashChatGptArtifactText(input.prompt)),
      submitted: false,
    };
  }

  async function verifyDraftInTarget(input: BrowserSessionOptions & { expected: string }): Promise<Record<string, unknown>> {
    const selected = await deps.resolveTarget(input);
    if (!selected.ok || !selected.target) return { ...selected, ok: false, status: "DRAFT_VERIFY_TARGET_NOT_READY" };
    const snapshot = await deps.readInputSnapshot(selected.target, input.timeoutMs);
    const actual = typeof snapshot.text === "string" ? snapshot.text : "";
    const verification = verifyDraft(input.expected, actual);
    return { ok: verification.draft_verification !== "MISMATCH", status: "DRAFT_VERIFICATION_READY", selected: deps.compactChatGptTarget(selected.target), snapshot: deps.redactInputSnapshot(snapshot, hashChatGptArtifactText(input.expected)), ...verification };
  }

  return { draftInput, verifyDraftInTarget };
}

function normalizeComposerOwnershipText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
