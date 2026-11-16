import { resolveWebFailureReason, type WebFailureReason } from "./WebFailureReason.js";
export type WebOutcomeDisposition =
  | "continue"
  | "waiting_human"
  | "reinspect"
  | "approval_required"
  | "needs_correction"
  | "terminal_success"
  | "terminal_uncertain"
  | "failed";

export type WebOutcomeClassification = {
  status: string | null;
  reasonCode?: string;
  resolution?: WebFailureReason["resolution"];
  disposition: WebOutcomeDisposition;
  automaticRetryAllowed: boolean;
  manualResumeAllowed: boolean;
  finalExternalActionMayHaveOccurred: boolean;
  recommendedAction: string;
};

export const webOutcomePolicySummary = Object.freeze({
  executionOwner: "console-mcp",
  humanBoundaryStatus: "WEB_HUMAN_ACTION_REQUIRED",
  humanBoundaryStatuses: Object.freeze([
    "WEB_HUMAN_ACTION_REQUIRED", "WEB_COOKIE_ACTION_REQUIRED", "WEB_CAPTCHA_ACTION_REQUIRED",
    "WEB_AUTH_ACTION_REQUIRED", "WEB_MFA_ACTION_REQUIRED",
  ]),
  terminalSuccessStatus: "WEB_SUBMIT_VERIFIED",
  terminalUncertainStatus: "WEB_SUBMIT_POSTCONDITION_UNVERIFIED",
  automaticSubmitRetryAllowed: false,
  staleMutationRequiresReinspection: true,
});

const GRANULAR_SESSION_FAILURES = new Set([
  "WEB_WINDOW_NOT_VISIBLE", "WEB_WINDOW_IDENTITY_UNVERIFIED", "WEB_WINDOW_FOREGROUND_MISMATCH",
  "WEB_GUI_SESSION_LOCKED", "WEB_GUI_SESSION_UNAVAILABLE", "WEB_VISIBILITY_PROOF_UNDETERMINED",
  "WEB_TARGET_SELECTION_AMBIGUOUS", "WEB_BROWSER_TARGET_STALE", "WEB_BROWSER_PROFILE_MISMATCH",
  "WEB_CDP_SESSION_UNAVAILABLE", "WEB_NATIVE_WINDOW_NOT_VISIBLE", "WEB_PAGE_NOT_FOREGROUND", "WEB_DESKTOP_INPUT_UNAVAILABLE",
  "WEB_GUI_SESSION_STATE_UNKNOWN", "WEB_CAUSE_UNDETERMINED",
  "WEB_VISIBLE_TARGET_IDENTITY_CHANGED", "WEB_VISIBLE_DISCOVERY_CHANGED", "WEB_SESSION_LEASE_BUSY",
  "WEB_VISIBLE_BINDING_CAPACITY",
]);

export function classifyWebConsumerOutcome(value: unknown): WebOutcomeClassification {
  const result = isRecord(value) ? value : {};
  const status = typeof result.status === "string" ? result.status : null;

  if (status === "WEB_SECRET_FILL_VERIFIED" || status === "WEB_SECRET_LOCAL_CLEANUP_REQUIRED"
      || (status === "WEB_SECRET_FILL_DENIED" && result.local_cleanup_required === true)) {
    return classification(status, "waiting_human", false, true, false,
      "Do not capture, retry or submit. A local operator must review quarantine, close the recorded browser and audit local cleanup before a fresh bind and approval.");
  }

  if (status === "WEB_SUBMIT_VERIFIED") {
    return classification(status, "terminal_success", false, false, true,
      "Treat the external submission as complete and preserve confirmation evidence.");
  }

  if (result.outcome_unknown === true || result.externalActionMayHaveOccurred === true ||
      status === "WEB_POST_OPERATION_PROOF_LOST" || result.reason === "POST_OPERATION_VISIBILITY_UNKNOWN") {
    return classification(status, "terminal_uncertain", false, true, true,
      "The operation may already have completed. Reconcile its external postcondition before any further action; never automatically replay.",
      resolveWebFailureReason(result));
  }

  if (status === "WEB_VISIBLE_SESSION_REQUIRED" || (status !== null && GRANULAR_SESSION_FAILURES.has(status))) {
    const reason = typeof result.reason === "string" ? result.reason : null;
    const detail = resolveWebFailureReason(result);
    const windowIssue = detail.resolution.actor !== "human";
    const locked = reason === "SESSION_LOCKED" || status === "WEB_GUI_SESSION_LOCKED";
    return classification(status, windowIssue ? "reinspect" : "waiting_human", false, true, false,
      locked ? "The graphical session is locked. Unlock it normally, then re-inspect; never bypass authentication." :
      windowIssue ? "The browser is connected but its intended GUI window is not verified. Inspect the existing window and restore it if minimized; do not open a duplicate browser or replay mutations." :
      "Inspect the reported visibility reason and bind a verified interactive browser session on the intended host; do not replay into an invisible CDP runtime.", detail);
  }

  if (status === "WEB_HUMAN_ACTION_REQUIRED"
      || status === "WEB_COOKIE_ACTION_REQUIRED"
      || status === "WEB_CAPTCHA_ACTION_REQUIRED"
      || status === "WEB_AUTH_ACTION_REQUIRED"
      || status === "WEB_MFA_ACTION_REQUIRED") {
    const detail = resolveWebFailureReason(result);
    if (detail.reasonCode === "WEB_CAUSE_UNDETERMINED"
        && (status === "WEB_HUMAN_ACTION_REQUIRED" || status === "WEB_AUTH_ACTION_REQUIRED")) {
      return classification(status, "reinspect", false, true, false,
        "The human-action category lacks a verified cause. Collect boundary evidence before assigning a human step.", detail);
    }
    return classification(status, "waiting_human", false, true, false,
      "Pause Console orchestration, let the user complete the verified human action, then re-inspect before resuming.", detail);
  }

  if (status === "WEB_SESSION_ROTATED_REINSPECT_REQUIRED" || status === "WEB_SESSION_ROTATION_UNVERIFIED") {
    return classification(status, "reinspect", false, true, false,
      "The rejected fill was not replayed. Re-bind the exact target, inspect the form and obtain a new approval receipt.");
  }

  if (status === "WEB_TARGET_STALE"
      || status === "WEB_PAGE_REVISION_STALE"
      || status === "WEB_FORM_REVISION_STALE") {
    return classification(status, "reinspect", false, true, false,
      "Do not replay the mutation. Re-bind/re-inspect the exact target and obtain fresh revisions first.");
  }

  if (status === "WEB_RATE_LIMITED") {
    return classification(status, "reinspect", false, true, false,
      "Rate window exhausted. Respect evidence.retryAfterSeconds and re-inspect target/form; obtain fresh approval, never automatically replay.", resolveWebFailureReason(result));
  }

  if (status === "WEB_OPERATION_SIZE_LIMIT") {
    return classification(status, "needs_correction", false, true, false,
      "The field set exceeds the bounded per-operation size. Split and re-approve against fresh page/form revisions.", resolveWebFailureReason(result));
  }

  if (status === "WEB_APPROVAL_REQUIRED" || status === "WEB_APPROVAL_STALE") {
    return classification(status, "approval_required", false, true, false,
      "Obtain fresh explicit approval bound to the current Web domain evidence before continuing.");
  }

  if (status === "WEB_SUBMIT_VALIDATION_FAILED") {
    return classification(status, "needs_correction", false, true, true,
      "Inspect validation evidence and correct the form. Never automatically repeat final submit.");
  }

  if (status === "WEB_SUBMIT_POSTCONDITION_UNVERIFIED") {
    return classification(status, "terminal_uncertain", false, true, true,
      "Treat the external action as potentially completed. Inspect manually; never automatically repeat submit.");
  }

  if (result.ok === true) {
    return classification(status, "continue", false, true, false,
      "Continue according to the Web domain receipt and current Console run plan.");
  }

  return classification(status, "failed", false, true, false,
    "Inspect the Web status/evidence and choose an explicit recovery action. Do not blindly replay mutations.");
}

function classification(
  status: string | null,
  disposition: WebOutcomeDisposition,
  automaticRetryAllowed: boolean,
  manualResumeAllowed: boolean,
  finalExternalActionMayHaveOccurred: boolean,
  recommendedAction: string,
  detail?: WebFailureReason,
): WebOutcomeClassification {
  return {
    status,
    ...(detail ? { reasonCode: detail.reasonCode, resolution: detail.resolution } : {}),
    disposition,
    automaticRetryAllowed,
    manualResumeAllowed,
    finalExternalActionMayHaveOccurred,
    recommendedAction,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

