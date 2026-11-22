import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/Consumer/Web/WebOutcomePolicy.ts", import.meta.url), "utf8");

for (const token of [
  '"WEB_HUMAN_ACTION_REQUIRED"',
  '"waiting_human"',
  '"WEB_TARGET_STALE"',
  '"WEB_PAGE_REVISION_STALE"',
  '"WEB_FORM_REVISION_STALE"',
  '"reinspect"',
  '"WEB_SUBMIT_VALIDATION_FAILED"',
  '"needs_correction"',
  '"WEB_SUBMIT_VERIFIED"',
  '"terminal_success"',
  '"WEB_SUBMIT_POSTCONDITION_UNVERIFIED"',
  '"terminal_uncertain"',
  'automaticSubmitRetryAllowed: false',
  'never automatically repeat submit',
]) {
  assert.equal(source.includes(token), true, `Web outcome policy invariant missing: ${token}`);
}

assert.equal(
  source.includes('executionOwner: "console-mcp"'),
  true,
  "Console MCP must own Web execution outcome policy",
);

console.log("Console Web outcome policy regression passed.");

const { classifyWebConsumerOutcome } = await import("../dist/Consumer/Web/WebOutcomePolicy.js");
for (const status of ["WEB_HUMAN_ACTION_REQUIRED", "WEB_CAPTCHA_ACTION_REQUIRED", "WEB_COOKIE_ACTION_REQUIRED", "WEB_AUTH_ACTION_REQUIRED", "WEB_MFA_ACTION_REQUIRED"]) {
  const result = classifyWebConsumerOutcome({ status });
  assert.equal(result.disposition, "reinspect", status);
  assert.equal(result.automaticRetryAllowed, false, status);
}
const evidenced = classifyWebConsumerOutcome({ status: "WEB_CAPTCHA_ACTION_REQUIRED", boundary: {
  type: "captcha", targetUrl: "https://example.test/form", source: "playwright-visible-dom", visibleChallengeWidget: true,
  observedAt: new Date().toISOString()
}});
assert.equal(evidenced.disposition, "waiting_human");
assert.equal(classifyWebConsumerOutcome({ status: "WEB_CAPTCHA_ACTION_REQUIRED", boundary: {
  type: "consent_required", targetUrl: "https://example.test/form", source: "playwright-visible-dom", visibleChallengeWidget: true,
  observedAt: new Date().toISOString()
}}).disposition, "reinspect");
console.log("Evidence-backed human-boundary classification regression passed.");

