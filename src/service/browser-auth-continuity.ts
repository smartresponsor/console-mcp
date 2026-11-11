import { sameVisibleRuntime, type VisibleSessionEvidence } from "./visible-browser-session.js";

export type BrowserAuthObservation = "AUTHENTICATED" | "LOGIN_REQUIRED" | "MFA_REQUIRED" | "CAPTCHA_REQUIRED" | "UNKNOWN";
export type BrowserAuthContinuity = {
  status: "WEB_AUTH_CONTINUITY_CONFIRMED" | "WEB_AUTH_LOGIN_REQUIRED" |
    "WEB_AUTH_MFA_REQUIRED" | "WEB_AUTH_CAPTCHA_REQUIRED" |
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
    : after.authentication === "MFA_REQUIRED" ? "WEB_AUTH_MFA_REQUIRED"
    : after.authentication === "CAPTCHA_REQUIRED" ? "WEB_AUTH_CAPTCHA_REQUIRED"
    : before.authentication === "AUTHENTICATED" && after.authentication === "AUTHENTICATED"
      ? "WEB_AUTH_CONTINUITY_CONFIRMED" : "WEB_AUTH_CONTINUITY_UNKNOWN";
  return { status, authenticated: status === "WEB_AUTH_CONTINUITY_CONFIRMED", automatic_retry_allowed: false };
}
