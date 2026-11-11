import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const bootstrap=readFileSync(join(root,'tool/dev-console.d/02-secret-bootstrap.ps1'),'utf8');
const smoke=readFileSync(join(root,'tool/dev-console.d/54-smoke-probes.ps1'),'utf8');
const rc=readFileSync(join(root,'src/tool/rc.ts'),'utf8');
assert.match(bootstrap,/'smoke-local-codex'/);
assert.match(bootstrap,/AwsSecretContract\/tool\/secret-runtime\.ps1/);
assert.match(smoke,/authenticatedSmoke\.ok -eq \$true/);
assert.match(rc,/await run\(`npm:\$\{script\}`/);
assert.ok(pkg.scripts['smoke:local-codex'],'Legacy authenticated smoke must remain present');
const candidateChecks=['build','schema:validate','test:visible-session','test:release-transaction','test:deployment-preflight','smoke'];
assert.deepEqual(candidateChecks.filter(n=>!pkg.scripts[n]),[]);
let sharedRuntime=null,cursor=root;
for(let depth=0;depth<6;depth++){
 const candidate=join(cursor,'AwsSecretContract','tool','secret-runtime.ps1');
 if(existsSync(candidate)){sharedRuntime=candidate;break;}
 const next=dirname(cursor);if(next===cursor)break;cursor=next;
}
const tokenPresent=Boolean(process.env.CONSOLE_MCP_BEARER_TOKEN);
let awsCredentialStatus='UNTESTED';
try{
 execFileSync('aws',['sts','get-caller-identity','--query','Account','--output','text'],{timeout:10000,stdio:'ignore',env:{...process.env,AWS_PAGER:'',AWS_EC2_METADATA_DISABLED:'true',AWS_MAX_ATTEMPTS:'1'}});
 awsCredentialStatus='IDENTITY_ACCESS_OK';
}catch{awsCredentialStatus='IDENTITY_UNAVAILABLE';}
const sourceAvailable=tokenPresent||sharedRuntime!==null||awsCredentialStatus==='IDENTITY_ACCESS_OK';
const report={status:sourceAvailable?'BEARER_SOURCE_POSSIBLE_UNVERIFIED':'BEARER_SOURCE_BLOCKED',candidate_checks_present:candidateChecks.length,legacy_authenticated_smoke_kept:true,shared_bootstrap_found:sharedRuntime!==null,token_env_present:tokenPresent,aws_credential_status:awsCredentialStatus,authenticated_smoke_run:false,secret_read:false,release_activation_allowed:false};
console.log(JSON.stringify(report));
if(!sourceAvailable)process.exitCode=2;
