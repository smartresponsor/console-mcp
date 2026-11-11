import assert from "node:assert/strict";
import { selectRcValidationScript as select, rcExternalAuthenticationBlocker, isRcExternalAuthenticationScript } from "../dist/tool/rc-validation-scope.js";
const ext=["smoke:local-codex","smoke:local-chatgpt","smoke:oauth","smoke:public"];
for(const name of ext){
 const node=select("node_package","npm",name);
 assert.deepEqual(node,{run:false,externalAuthenticationRequired:true},name);
 assert.deepEqual(select("mixed","npm",name),{run:true,externalAuthenticationRequired:false});
 assert.deepEqual(select("auto","npm",name),{run:true,externalAuthenticationRequired:false});
}
for(const name of ["build","schema:validate","test:visible-session","smoke","test:deployment-preflight"]){
 assert.deepEqual(select("node_package","npm",name),{run:true,externalAuthenticationRequired:false},name);
}
assert.equal(select("node_package","composer","test").run,false);
assert.equal(select("symfony_host","npm","build").run,false);
assert.equal(select("symfony_host","composer","test").run,true);
assert.equal(select("mixed","composer","test").run,true);
assert.equal(select("auto","npm","smoke:local-codex").run,true);
for(const mode of ["diagnose","validate","plan","repair"]){
 assert.equal(rcExternalAuthenticationBlocker(mode,"node_package",["npm:smoke:local-codex"]),null);
}
assert.equal(rcExternalAuthenticationBlocker("full","node_package",["npm:smoke:local-codex"]),"external_authentication_not_validated");
assert.equal(rcExternalAuthenticationBlocker("full","node_package",[]),null);
assert.equal(rcExternalAuthenticationBlocker("full","mixed",["npm:smoke:local-codex"]),"external_authentication_not_validated");
assert.equal(rcExternalAuthenticationBlocker("full","auto",["npm:smoke:local-codex"]),"external_authentication_not_validated");
for(const name of ext) assert.equal(isRcExternalAuthenticationScript(name),true);
assert.equal(isRcExternalAuthenticationScript("smoke"),false);
console.log("RC_VALIDATION_PROFILE_SELECTION_GREEN: node_package code-only; full release cannot hide omitted bearer auth");
