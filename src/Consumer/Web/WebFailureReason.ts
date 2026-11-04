/** Stable diagnostic reasons; legacy Web status is intentionally preserved. */
export type WebRecoveryActor = "console_mcp" | "browser_supervisor" | "human" | "engineering";
export type WebFailureReason = {
  reasonCode: string;
  resolution: { actor: WebRecoveryActor; action: string };
  automatic_retry_allowed: false;
};

const REASONS: Readonly<Record<string, { code: string; actor: WebRecoveryActor; action: string }>> = Object.freeze({
  WINDOW_NOT_VISIBLE: { code: "WEB_WINDOW_NOT_VISIBLE", actor: "browser_supervisor", action: "INSPECT_AND_ACTIVATE_EXACT_WINDOW" },
  WINDOW_NOT_VERIFIED: { code: "WEB_WINDOW_IDENTITY_UNVERIFIED", actor: "browser_supervisor", action: "VERIFY_WINDOW_PROCESS_AND_TARGET" },
  TARGET_WINDOW_MISMATCH: { code: "WEB_WINDOW_FOREGROUND_MISMATCH", actor: "browser_supervisor", action: "ACTIVATE_VERIFIED_TARGET_WINDOW" },
  SESSION_NOT_VISIBLE: { code: "WEB_WINDOW_NOT_VISIBLE", actor: "browser_supervisor", action: "INSPECT_AND_ACTIVATE_EXACT_WINDOW" },
  SESSION_LOCKED: { code: "WEB_GUI_SESSION_LOCKED", actor: "human", action: "UNLOCK_SESSION" },
  GUI_SESSION_UNAVAILABLE: { code: "WEB_GUI_SESSION_UNAVAILABLE", actor: "engineering", action: "REPAIR_DESKTOP_SESSION" },
  VISIBILITY_UNKNOWN: { code: "WEB_VISIBILITY_PROOF_UNDETERMINED", actor: "browser_supervisor", action: "INSPECT_NATIVE_WINDOW_EVIDENCE" },
  AMBIGUOUS_VISIBLE_SESSIONS: { code: "WEB_TARGET_SELECTION_AMBIGUOUS", actor: "console_mcp", action: "BIND_EXACT_TARGET" },
  VISIBLE_DISCOVERY_CHANGED: { code: "WEB_VISIBLE_DISCOVERY_CHANGED", actor: "console_mcp", action: "REINSPECT_EXACT_TARGET" },
  VISIBLE_SESSION_BUSY: { code: "WEB_SESSION_LEASE_BUSY", actor: "console_mcp", action: "WAIT_FOR_LEASE_RELEASE" },
  BROWSER_TARGET_STALE: { code: "WEB_BROWSER_TARGET_STALE", actor: "console_mcp", action: "REINSPECT_EXACT_TARGET" },
  TARGET_BELONGS_TO_ANOTHER_SESSION: { code: "WEB_BROWSER_PROFILE_MISMATCH", actor: "browser_supervisor", action: "VERIFY_BROWSER_PROFILE_OWNERSHIP" },
  VISIBLE_TARGET_IDENTITY_CHANGED: { code: "WEB_VISIBLE_TARGET_IDENTITY_CHANGED", actor: "console_mcp", action: "EXPLICIT_REBIND_REQUIRED" },
  VISIBLE_BINDING_CAPACITY_REACHED: { code: "WEB_VISIBLE_BINDING_CAPACITY", actor: "engineering", action: "INSPECT_BINDING_CAPACITY" },
  login_required: { code: "WEB_AUTH_LOGIN_REQUIRED", actor: "human", action: "COMPLETE_LOGIN" },
  account_selection_required: { code: "WEB_AUTH_ACCOUNT_SELECTION_REQUIRED", actor: "human", action: "SELECT_ACCOUNT" },
  mfa_required: { code: "WEB_AUTH_MFA_REQUIRED", actor: "human", action: "COMPLETE_MFA" },
  captcha_required: { code: "WEB_AUTH_CAPTCHA_REQUIRED", actor: "human", action: "COMPLETE_CHALLENGE" },
  cookie_consent_required: { code: "WEB_COOKIE_CONSENT_REQUIRED", actor: "human", action: "REVIEW_CONSENT" },
  consent_required: { code: "WEB_COOKIE_CONSENT_REQUIRED", actor: "human", action: "REVIEW_CONSENT" },
});
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Never infer auth/MFA from URL alone or upgrade missing evidence to a human-action claim. */
export function resolveWebFailureReason(value: unknown): WebFailureReason {
  const result = record(value);
  const evidence = record(result.evidence);
  const boundary = Object.keys(record(result.boundary)).length ? record(result.boundary) : record(evidence.boundary);
  const diagnostic = record(evidence.x11Diagnostic);
  const legacyReason = typeof result.reason === "string" ? result.reason : "";
  const status = typeof result.status === "string" ? result.status : "";
  let reason = legacyReason;
  if (status === "WEB_HUMAN_ACTION_REQUIRED" && typeof boundary.type === "string") reason = boundary.type;
  if (status === "WEB_VISIBLE_SESSION_REQUIRED" && legacyReason === "VISIBILITY_UNKNOWN"
      && diagnostic.stage === "window_mismatch") reason = "TARGET_WINDOW_MISMATCH";
  const known = Object.hasOwn(REASONS, reason) ? REASONS[reason] : undefined;
  if (known) return { reasonCode: known.code,
    resolution: { actor: known.actor, action: known.action },
    automatic_retry_allowed: false };
  if (status === "WEB_RATE_LIMITED") return {
    reasonCode: "WEB_RATE_LIMITED", resolution: { actor: "console_mcp", action: "WAIT_FOR_RATE_WINDOW_AND_REINSPECT" }, automatic_retry_allowed: false };
  if (status === "WEB_OPERATION_SIZE_LIMIT") return {
    reasonCode: "WEB_OPERATION_SIZE_LIMIT", resolution: { actor: "console_mcp", action: "SPLIT_OVERSIZED_FIELD_SET" }, automatic_retry_allowed: false };
  if (status === "WEB_MFA_ACTION_REQUIRED") return {
    reasonCode: "WEB_AUTH_MFA_REQUIRED", resolution: { actor: "human", action: "COMPLETE_MFA" }, automatic_retry_allowed: false };
  if (status === "WEB_CAPTCHA_ACTION_REQUIRED") return {
    reasonCode: "WEB_AUTH_CAPTCHA_REQUIRED", resolution: { actor: "human", action: "COMPLETE_CHALLENGE" }, automatic_retry_allowed: false };
  return { reasonCode: "WEB_CAUSE_UNDETERMINED",
    resolution: { actor: "engineering", action: "COLLECT_EVIDENCE_AND_REINSPECT" },
    automatic_retry_allowed: false };
}
