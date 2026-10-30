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
  disposition: WebOutcomeDisposition;
  automaticRetryAllowed: boolean;
  manualResumeAllowed: boolean;
  finalExternalActionMayHaveOccurred: boolean;
  recommendedAction: string;
};

export const webOutcomePolicySummary = Object.freeze({
  executionOwner: "console-mcp",
  humanBoundaryStatus: "WEB_HUMAN_ACTION_REQUIRED",
  terminalSuccessStatus: "WEB_SUBMIT_VERIFIED",
  terminalUncertainStatus: "WEB_SUBMIT_POSTCONDITION_UNVERIFIED",
  automaticSubmitRetryAllowed: false,
  staleMutationRequiresReinspection: true,
});

export function classifyWebConsumerOutcome(value: unknown): WebOutcomeClassification {
  const result = isRecord(value) ? value : {};
  const status = typeof result.status === "string" ? result.status : null;

  if (status === "WEB_SECRET_FILL_VERIFIED" || status === "WEB_SECRET_LOCAL_CLEANUP_REQUIRED"
      || (status === "WEB_SECRET_FILL_DENIED" && result.local_cleanup_required === true)) {
    return classification(status, "waiting_human", false, true, false,
      "Do not capture, retry or submit. A local operator must review quarantine, close the recorded browser and audit local cleanup before a fresh bind and approval.");
  }

  if (status === "WEB_VISIBLE_SESSION_REQUIRED") {
    const reason = typeof result.reason === "string" ? result.reason : null;
    const windowIssue = reason === "WINDOW_NOT_VISIBLE" || reason === "WINDOW_NOT_VERIFIED" || reason === "TARGET_WINDOW_MISMATCH";
    const locked = reason === "SESSION_LOCKED";
    return classification(status, windowIssue ? "reinspect" : "waiting_human", false, true, false,
      locked ? "The graphical session is locked. Unlock it normally, then re-inspect; never bypass authentication." :
      windowIssue ? "The browser is connected but its intended GUI window is not verified. Inspect the existing window and restore it if minimized; do not open a duplicate browser or replay mutations." :
      "Inspect the reported visibility reason and bind a verified interactive browser session on the intended host; do not replay into an invisible CDP runtime.");
  }

  if (status === "WEB_HUMAN_ACTION_REQUIRED") {
    return classification(status, "waiting_human", false, true, false,
      "Pause Console orchestration, let the user complete the requested human action, then re-inspect before resuming.");
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

  if (status === "WEB_APPROVAL_REQUIRED" || status === "WEB_APPROVAL_STALE") {
    return classification(status, "approval_required", false, true, false,
      "Obtain fresh explicit approval bound to the current Web domain evidence before continuing.");
  }

  if (status === "WEB_SUBMIT_VALIDATION_FAILED") {
    return classification(status, "needs_correction", false, true, true,
      "Inspect validation evidence and correct the form. Never automatically repeat final submit.");
  }

  if (status === "WEB_SUBMIT_VERIFIED") {
    return classification(status, "terminal_success", false, false, true,
      "Treat the external submission as complete and preserve confirmation evidence.");
  }

  if (status === "WEB_SUBMIT_POSTCONDITION_UNVERIFIED" || result.externalActionMayHaveOccurred === true) {
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
): WebOutcomeClassification {
  return {
    status,
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

