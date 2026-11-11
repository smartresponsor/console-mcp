import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {registerRcTool} from "../dist/tool/rc.js";
const root=await mkdtemp(join(tmpdir(),"rc-validation-profile-"));
try{
 execFileSync("git",["init","-q",root]);
 const scripts={build:'node -e "process.exit(0)"'};
 for(const letter of "abcdefg")scripts[`check:${letter}`]='node -e "process.exit(0)"';
 scripts["smoke:local-codex"]='node -e "process.exit(42)"';
 await writeFile(join(root,"package.json"),JSON.stringify({name:"rc-scope-fixture",version:"1.0.0",scripts}));
 const handlers=new Map(), server={registerTool(name,config,handler){handlers.set(name,handler);}};
 registerRcTool(server,{workspaceRoot:join(root,"workspace"),allowedRoots:[root],maxStatusLines:200,deniedPath:{denyBasenames:[],denyExtensions:[],denyPathFragments:[],allowlist:[]}},{mode:"bearer"});
 async function invoke(name,profile){
  const result=await handlers.get(name)({workspacePath:root,maxFiles:80,maxIssues:20,dirtyPolicy:"allow_existing_readonly",validationProfile:profile,allowedPaths:[],forbiddenPaths:[],repairLimit:0,advisorMode:"off",timeoutMs:30000});
  return result.structuredContent??JSON.parse(result.content[0].text);
 }
 const code=await invoke("read_.release.rc.validate","node_package");
 assert.ok(code.readiness,JSON.stringify({error:code.error,keys:Object.keys(code)}));
 assert.equal(code.readiness.status,"rc_diagnostic_blocked",JSON.stringify(code.error??code.readiness));
 assert.ok(code.readiness.blockers.includes("rc_script_admission_review_required"));
 assert.ok(code.validation_results.admission_review_required.includes("npm:check:a"));
 assert.ok(code.validation_results.admission_review_required.includes("npm:build"));
 assert.equal(code.validation_results.command_count,0);
 assert.equal(code.readiness.full_release_authorized,false);
 assert.ok(code.readiness.warnings.includes("external_authentication_not_validated"));
 assert.ok(code.validation_results.external_authentication_required.includes("npm:smoke:local-codex"));
 assert.ok(!code.validation_results.commands.some(c=>c.label==="npm:smoke:local-codex"));
 const full=await invoke("read_.release.rc.full","node_package");
 assert.equal(full.readiness.status,"rc_diagnostic_blocked");
 assert.ok(full.readiness.blockers.includes("external_authentication_not_validated"));
 assert.equal(full.readiness.full_release_authorized,false);
 assert.ok(!full.validation_results.commands.some(c=>c.label==="npm:smoke:local-codex"));
 const auto=await invoke("read_.release.rc.full","auto");
 assert.equal(auto.readiness.status,"rc_diagnostic_blocked");
 assert.ok(auto.readiness.blockers.includes("external_authentication_not_validated"));
 assert.equal(auto.validation_results.command_count,0);
 assert.ok(auto.readiness.blockers.includes("rc_script_admission_review_required"));
 assert.ok(auto.validation_results.admission_review_required.includes("npm:check:g"));
 assert.ok(!auto.validation_results.commands.some(c=>c.label==="npm:smoke:local-codex"));
 console.log(JSON.stringify({status:"RC_VALIDATION_PROFILE_LIVE_CONTRACT_GREEN",codeScopeGreen:false,unreviewedScriptsBlocked:true,fullBlockedWithoutAuth:true,autoLimitCannotHideAuth:true,fixtureOnly:true,secretRead:false,codexRun:false}));
}finally{await rm(root,{recursive:true,force:true});}
