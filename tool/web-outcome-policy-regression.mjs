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
for (const status of ['WEB_COOKIE_ACTION_REQUIRED','WEB_CAPTCHA_ACTION_REQUIRED','WEB_MFA_ACTION_REQUIRED']) {
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

const unknownHuman = classifyWebConsumerOutcome({ok:false,status:'WEB_HUMAN_ACTION_REQUIRED'});
assert.equal(unknownHuman.disposition,'reinspect','Unproven human need must not be presumed');
assert.equal(unknownHuman.reasonCode,'WEB_CAUSE_UNDETERMINED');
assert.equal(unknownHuman.resolution.actor,'engineering');
const login = classifyWebConsumerOutcome({ok:false,status:'WEB_HUMAN_ACTION_REQUIRED',evidence:{boundary:{type:'login_required'}}});
assert.equal(login.disposition,'waiting_human');
assert.equal(login.reasonCode,'WEB_AUTH_LOGIN_REQUIRED');
assert.equal(login.resolution.actor,'human');
const amazonConsent = classifyWebConsumerOutcome({ok:false,status:'WEB_HUMAN_ACTION_REQUIRED',
  boundary:{type:'consent_required',requestedAction:'Review privacy/cookie consent',targetUrl:'https://www.amazon.jobs/en/'}});
assert.equal(amazonConsent.status,'WEB_HUMAN_ACTION_REQUIRED');
assert.equal(amazonConsent.disposition,'waiting_human');
assert.equal(amazonConsent.reasonCode,'WEB_COOKIE_CONSENT_REQUIRED');
assert.equal(amazonConsent.resolution.actor,'human');
assert.equal(amazonConsent.resolution.action,'REVIEW_CONSENT');
const mismatch = classifyWebConsumerOutcome({ok:false,status:'WEB_VISIBLE_SESSION_REQUIRED',reason:'VISIBILITY_UNKNOWN',
  evidence:{x11Diagnostic:{stage:'window_mismatch'}}});
assert.equal(mismatch.disposition,'reinspect');
assert.equal(mismatch.reasonCode,'WEB_WINDOW_FOREGROUND_MISMATCH');
assert.equal(mismatch.resolution.actor,'browser_supervisor');
const ambiguous = classifyWebConsumerOutcome({ok:false,status:'WEB_VISIBLE_SESSION_REQUIRED',reason:'AMBIGUOUS_VISIBLE_SESSIONS'});
assert.equal(ambiguous.reasonCode,'WEB_TARGET_SELECTION_AMBIGUOUS');
assert.equal(ambiguous.resolution.action,'BIND_EXACT_TARGET');
const busy = classifyWebConsumerOutcome({ok:false,status:'WEB_VISIBLE_SESSION_REQUIRED',reason:'VISIBLE_SESSION_BUSY'});
assert.equal(busy.reasonCode,'WEB_SESSION_LEASE_BUSY');
const undetermined = classifyWebConsumerOutcome({ok:false,status:'WEB_VISIBLE_SESSION_REQUIRED',reason:'NONEXISTENT_REASON'});
assert.equal(undetermined.disposition,'reinspect');
assert.equal(undetermined.reasonCode,'WEB_CAUSE_UNDETERMINED');
console.log('Evidence-backed Web reason canonicalization regression passed.');

for (const [status, reason, expectedCode, disposition] of [
  ['WEB_CDP_SESSION_UNAVAILABLE', 'SESSION_UNAVAILABLE', 'WEB_CDP_SESSION_UNAVAILABLE', 'reinspect'],
  ['WEB_NATIVE_WINDOW_NOT_VISIBLE', 'SESSION_NOT_VISIBLE', 'WEB_NATIVE_WINDOW_NOT_VISIBLE', 'reinspect'],
  ['WEB_GUI_SESSION_LOCKED', 'SESSION_LOCKED', 'WEB_GUI_SESSION_LOCKED', 'waiting_human'],
  ['WEB_SESSION_LEASE_BUSY', 'VISIBLE_SESSION_BUSY', 'WEB_SESSION_LEASE_BUSY', 'reinspect'],
  ['WEB_POST_OPERATION_PROOF_LOST', 'POST_OPERATION_VISIBILITY_UNKNOWN', 'WEB_POST_OPERATION_PROOF_LOST', 'reinspect'],
]) {
  const outcome = classifyWebConsumerOutcome({ok:false,status,reason});
  assert.equal(outcome.reasonCode, expectedCode, status);
  assert.equal(outcome.disposition, disposition, status);
  assert.equal(outcome.automaticRetryAllowed, false, status);
}
console.log('Granular Web session outcome regression passed.');

for (const [status, expectedActor] of [
  ['WEB_CDP_SESSION_UNAVAILABLE', 'browser_supervisor'],
  ['WEB_GUI_SESSION_LOCKED', 'human'],
  ['WEB_POST_OPERATION_PROOF_LOST', 'engineering'],
  ['WEB_NATIVE_WINDOW_NOT_VISIBLE', 'browser_supervisor'],
]) {
  const outcome = classifyWebConsumerOutcome({ok:false,status});
  assert.equal(outcome.reasonCode, status, `status-only canonicalization: ${status}`);
  assert.equal(outcome.resolution?.actor, expectedActor, status);
  assert.equal(outcome.automaticRetryAllowed, false, status);
}
for (const failure of [
  { status: 'WEB_POST_OPERATION_PROOF_LOST' },
  { status: 'WEB_VISIBILITY_PROOF_UNDETERMINED', reason: 'POST_OPERATION_VISIBILITY_UNKNOWN' },
]) {
  const result = classifyWebConsumerOutcome(failure);
  assert.equal(result.disposition, 'terminal_uncertain', 'Lost post-operation proof is never a safe retry');
  assert.equal(result.finalExternalActionMayHaveOccurred, true);
  assert.equal(result.automaticRetryAllowed, false);
}
console.log('Status-only granular Web failures regression passed.');
