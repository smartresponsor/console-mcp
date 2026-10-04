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
  humanBoundaryStatus: "NETWORK_HUMAN_ACTION_REQUIRED",
  terminalSuccessStatus: "NETWORK_SUBMIT_VERIFIED",
  terminalUncertainStatus: "NETWORK_SUBMIT_POSTCONDITION_UNVERIFIED",
  automaticSubmitRetryAllowed: false,
  staleMutationRequiresReinspection: true,
});

export function classifyWebConsumerOutcome(value: unknown): WebOutcomeClassification {
  const result = isRecord(value) ? value : {};
  const status = typeof result.status === "string" ? result.status : null;

  if (status === "NETWORK_HUMAN_ACTION_REQUIRED") {
    return classification(status, "waiting_human", false, true, false,
      "Pause Console orchestration, let the user complete the requested human action, then re-inspect before resuming.");
  }

  if (status === "NETWORK_TARGET_STALE"
      || status === "NETWORK_PAGE_REVISION_STALE"
      || status === "NETWORK_FORM_REVISION_STALE") {
    return classification(status, "reinspect", false, true, false,
      "Do not replay the mutation. Re-bind/re-inspect the exact target and obtain fresh revisions first.");
  }

  if (status === "NETWORK_APPROVAL_REQUIRED" || status === "NETWORK_APPROVAL_STALE") {
    return classification(status, "approval_required", false, true, false,
      "Obtain fresh explicit approval bound to the current Network domain evidence before continuing.");
  }

  if (status === "NETWORK_SUBMIT_VALIDATION_FAILED") {
    return classification(status, "needs_correction", false, true, true,
      "Inspect validation evidence and correct the form. Never automatically repeat final submit.");
  }

  if (status === "NETWORK_SUBMIT_VERIFIED") {
    return classification(status, "terminal_success", false, false, true,
      "Treat the external submission as complete and preserve confirmation evidence.");
  }

  if (status === "NETWORK_SUBMIT_POSTCONDITION_UNVERIFIED" || result.externalActionMayHaveOccurred === true) {
    return classification(status, "terminal_uncertain", false, true, true,
      "Treat the external action as potentially completed. Inspect manually; never automatically repeat submit.");
  }

  if (result.ok === true) {
    return classification(status, "continue", false, true, false,
      "Continue according to the Network domain receipt and current Console run plan.");
  }

  return classification(status, "failed", false, true, false,
    "Inspect the Network status/evidence and choose an explicit recovery action. Do not blindly replay mutations.");
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

