/** Explicit background-read admission: independent of interactive UI readiness. */
export const backgroundReadToolNames = new Set(["read_.web.page.capture.dom", "read_.web.page.capture.form", "read_.web.page.capture"]);
export const backgroundReadAllowedHosts = new Set(["www.nellisauction.com", "jobs.ashbyhq.com"]);
export function backgroundReadDecision(input: { tool: string; url: string; sessionKind: string; provisioned: boolean }): { allowed: boolean; reason: string } {
  if (!backgroundReadToolNames.has(input.tool)) return { allowed: false, reason: "NOT_READ_ONLY_CAPTURE" };
  if (input.sessionKind !== "dedicated-background") return { allowed: false, reason: "DEDICATED_SESSION_REQUIRED" };
  // Explicit authorization is per separate runtime. Never borrow the visible Edge profile.
  if (!input.provisioned) return { allowed: false, reason: "BACKGROUND_CREDENTIALS_NOT_PROVISIONED" };
  let url: URL;
  try { url = new URL(input.url); } catch { return { allowed: false, reason: "INVALID_URL" }; }
  if (url.protocol !== "https:" || !backgroundReadAllowedHosts.has(url.hostname)) return { allowed: false, reason: "HOST_NOT_ALLOWED" };
  return { allowed: true, reason: "BACKGROUND_READ_ALLOWED" };
}
