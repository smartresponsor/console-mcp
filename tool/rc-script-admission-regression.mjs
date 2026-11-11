import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {rcScriptEligible,rcScriptAdmission,admittedRcNpmScripts} from "../dist/tool/rc-script-admission.js";
const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
const expected=["build","schema:validate","smoke","test:deployment-preflight","test:release-transaction","test:visible-session"];
assert.deepEqual(Object.keys(admittedRcNpmScripts).sort(),expected);
for(const name of expected){
 assert.ok(rcScriptEligible("npm",name),`approved script must be considered: ${name}`);
 assert.equal(rcScriptAdmission("npm",name,pkg.scripts[name]),"admitted",name);
 assert.equal(rcScriptAdmission("npm",name,pkg.scripts[name]+" && exit 0"),"review_required",`script drift must fail closed: ${name}`);
}
for(const name of ["test","test:console","test:database","smoke:admission","typecheck"]){
 assert.equal(rcScriptAdmission("npm",name,pkg.scripts[name]),"review_required",name);
}
assert.equal(rcScriptAdmission("composer","test","true"),"review_required");
assert.equal(rcScriptAdmission("npm","missing",undefined),"review_required");
assert.equal(rcScriptEligible("npm","test:deployment-preflight"),true);
assert.equal(rcScriptEligible("npm","restart-server"),false);
console.log(JSON.stringify({status:"RC_SCRIPT_ADMISSION_GREEN",reviewed:expected.length,definitionDriftDenied:true,unreviewedDenied:true,liveAuthWasNotRun:true}));
