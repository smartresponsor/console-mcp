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


const { classifyWebConsumerOutcome } = await import('../dist/Consumer/Web/WebOutcomePolicy.js');
for (const status of ['WEB_HUMAN_ACTION_REQUIRED','WEB_COOKIE_ACTION_REQUIRED','WEB_CAPTCHA_ACTION_REQUIRED','WEB_AUTH_ACTION_REQUIRED','WEB_MFA_ACTION_REQUIRED']) {
  const outcome=classifyWebConsumerOutcome({ok:false,status});
  assert.equal(outcome.disposition,'waiting_human',status);
  assert.equal(outcome.automaticRetryAllowed,false,status);
  assert.equal(outcome.manualResumeAllowed,true,status);
  assert.equal(outcome.finalExternalActionMayHaveOccurred,false,status);
}
assert.equal(classifyWebConsumerOutcome({status:'WEB_UNKNOWN_ACTION_REQUIRED'}).disposition,'failed');
for (const status of ['WEB_SECRET_FILL_VERIFIED', 'WEB_SECRET_LOCAL_CLEANUP_REQUIRED', 'WEB_SECRET_FILL_DENIED']) {
  const result = classifyWebConsumerOutcome({ ok: status === 'WEB_SECRET_FILL_VERIFIED', status, local_cleanup_required: true });
  assert.equal(result.disposition, 'waiting_human');
  assert.equal(result.automaticRetryAllowed, false);
  assert.equal(result.finalExternalActionMayHaveOccurred, false);
  assert.match(result.recommendedAction, /local operator/);
}
console.log('Secret quarantine outcome regression passed.');
