import { sameVisibleRuntime, type VisibleSessionEvidence } from "./visible-browser-session.js";

export type BrowserAuthObservation = "AUTHENTICATED" | "LOGIN_REQUIRED" | "UNKNOWN";
export type BrowserAuthContinuity = {
  status: "WEB_AUTH_CONTINUITY_CONFIRMED" | "WEB_AUTH_LOGIN_REQUIRED" |
    "WEB_AUTH_CONTINUITY_UNKNOWN" | "WEB_AUTH_SESSION_IDENTITY_CHANGED";
  authenticated: boolean;
  automatic_retry_allowed: false;
};

export function assessBrowserAuthContinuity(
  before: { evidence: VisibleSessionEvidence; authentication: BrowserAuthObservation },
  after: { evidence: VisibleSessionEvidence; authentication: BrowserAuthObservation },
): BrowserAuthContinuity {
  const status = !sameVisibleRuntime(before.evidence, after.evidence) ||
    before.evidence.targetId === null || after.evidence.targetId !== before.evidence.targetId
    ? "WEB_AUTH_SESSION_IDENTITY_CHANGED"
    : after.authentication === "LOGIN_REQUIRED" ? "WEB_AUTH_LOGIN_REQUIRED"
    : before.authentication === "AUTHENTICATED" && after.authentication === "AUTHENTICATED"
      ? "WEB_AUTH_CONTINUITY_CONFIRMED" : "WEB_AUTH_CONTINUITY_UNKNOWN";
  return { status, authenticated: status === "WEB_AUTH_CONTINUITY_CONFIRMED", automatic_retry_allowed: false };
}
