import assert from "node:assert/strict";
import {registerRcTool} from "../dist/tool/rc.js";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
const workspace=resolve(fileURLToPath(new URL("../",import.meta.url)));
const calls=new Map();
registerRcTool({registerTool(n,_config,h){calls.set(n,h)}},{
 workspaceRoot:workspace,allowedRoots:[workspace],maxStatusLines:200,
 deniedPath:{denyBasenames:[],denyExtensions:[],denyPathFragments:[],allowlist:[]}
},{mode:"bearer"});
const result=await calls.get("read_.release.rc.full")({
 workspacePath:workspace,component:"browser-facade",maxFiles:2000,maxIssues:500,
 dirtyPolicy:"allow_existing_readonly",validationProfile:"node_package",
 allowedPaths:[],forbiddenPaths:[],repairLimit:0,advisorMode:"off",timeoutMs:180000
});
const body=result.structuredContent??JSON.parse(result.content[0].text);
assert.ok(body.readiness,JSON.stringify({error:body.error}));
const ran=body.validation_results?.commands?.map(x=>({name:x.label,ok:x.ok,exitCode:x.exit_code}))??[];
const denied=body.validation_results?.admission_review_required??[];
const auth=body.validation_results?.external_authentication_required??[];
assert.equal(body.readiness.status,"rc_diagnostic_blocked");
assert.ok(body.readiness.blockers.includes("rc_script_admission_review_required"));
assert.ok(body.readiness.blockers.includes("external_authentication_not_validated"));
assert.ok(denied.includes("npm:test:database"));
assert.ok(denied.includes("npm:test"));
assert.equal(body.readiness.full_release_authorized,false);
assert.ok(ran.every(x=>["npm:build","npm:smoke","npm:schema:validate","npm:test:deployment-preflight","npm:test:release-transaction","npm:test:visible-session"].includes(x.name)));
assert.ok(!ran.some(x=>x.name==="npm:smoke:local-codex"||x.name==="npm:test:database"));
console.log(JSON.stringify({status:"RC_ACTUAL_CHECKOUT_ADMISSION_PROOF",readiness:body.readiness.status,commands:ran,unreviewedCount:denied.length,liveAuthRequiredCount:auth.length,codeChecksOk:ran.every(x=>x.ok),fullReleaseAuthorized:false,secretRead:false,codexInvoked:false,productionMutated:false}));
