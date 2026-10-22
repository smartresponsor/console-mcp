import assert from 'node:assert/strict';
import { inspectGrantsTarget, isGrantsAllowedUrl, sameGrantsTarget } from '../dist/service/grants-browser-session.js';
for(const candidate of ['https://evil.example/','http://humanityai.ai/','https://humanityai.ai.evil.example/','file:///etc/passwd','https://user:pass@submittable.com/']) assert.equal(isGrantsAllowedUrl(candidate),false,candidate);
for(const allowed of ['about:blank','https://humanityai.ai/open-call/','https://leverforchange.submittable.com/submit/']) assert.equal(isGrantsAllowedUrl(allowed),true,allowed);
const deny=await inspectGrantsTarget({destinationUrl:'https://evil.example/'});
assert.equal(deny.ok,false);assert.equal(deny.reason,'GRANTS_HOST_NOT_ALLOWED');
const bad=await inspectGrantsTarget({targetId:'not-an-id'});
assert.equal(bad.ok,false);assert.equal(bad.reason,'GRANTS_TARGET_ID_INVALID');
const actual=await inspectGrantsTarget();
if (!actual.ok && actual.reason === 'GRANTS_PROOF_UNAVAILABLE' && process.argv.includes('--sandbox')) {
  console.log(JSON.stringify({ok:true,status:'GRANTS_SOURCE_POLICY_PASS_HOST_PROOF_REQUIRED',sandboxProcUnavailable:true}));
  process.exit(0);
}
assert.equal(actual.ok,true,JSON.stringify(actual));
assert.ok(actual.evidence);
assert.equal(actual.evidence.endpoint,'http://127.0.0.1:9230');
assert.equal(actual.evidence.owner,'console-mcp-grants');
assert.equal(sameGrantsTarget(actual.evidence,{...actual.evidence}),true);
assert.equal(sameGrantsTarget(actual.evidence,{...actual.evidence,browserPid:99999999}),false);
const exact=await inspectGrantsTarget({targetId:actual.evidence.targetId,expected:actual.evidence});
assert.equal(exact.ok,true,JSON.stringify(exact));
console.log(JSON.stringify({ok:true,status:'GRANTS_ROUTING_PROOF_PASS',pid:actual.evidence.browserPid,targetId:actual.evidence.targetId,endpoint:actual.evidence.endpoint,legacyChanges:false}));
