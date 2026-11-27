param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Fa-f0-9]{32}$')][string]$TargetId)
$ErrorActionPreference='Stop'
& node --input-type=module -e @'
import assert from 'node:assert/strict';
import {inspectComposerPreflight,buildAuthState,classifyComposerReadiness} from './dist/service/browser-session-executor.js';
const targetId=process.argv[1].toUpperCase();
const port=9224, href='https://chatgpt.com/';
const target={id:targetId,url:href};
const proof={target_id:targetId,href,visible_text_sample:'Recents',target_session_authenticated:true};
assert.equal(buildAuthState({target,preflight:proof}).authenticated,true);
assert.equal(buildAuthState({target,preflight:{...proof,target_id:'wrong-target'}}).authenticated,'unknown');
assert.equal(buildAuthState({target,preflight:{...proof,href:href+'other'}}).authenticated,'unknown');
assert.equal(buildAuthState({target,preflight:{...proof,visible_text_sample:'Log in'}}).authenticated,false);
assert.equal(buildAuthState({target,preflight:{...proof,target_session_authenticated:false}}).authenticated,'unknown');
const list=await (await fetch('http://127.0.0.1:9224/json/list',{signal:AbortSignal.timeout(3000)})).json();
const matches=list.filter(t=>t.id===targetId&&t.type==='page'&&t.url===href&&t.webSocketDebuggerUrl==='ws://127.0.0.1:9224/devtools/page/'+targetId);
assert.equal(matches.length,1,'EXACT_ISOLATED_ROOT_REQUIRED');
const observed=await inspectComposerPreflight({targetId,ports:[port],timeoutMs:5000});
const readiness=classifyComposerReadiness(observed,'draft');
const result={status:'PRODUCT_TARGET_AUTH_INTEGRATED_OBSERVATION',targetId:observed.target_id===targetId?targetId:null,port:observed.port,exactRoot:observed.href===href,authenticated:observed.auth_state?.authenticated??null,targetSessionProof:observed.target_session_authenticated===true,composerEmpty:observed.composer?.textLength===0,composerVisible:observed.composer?.visible===true,messageCount:observed.message_count??null,overlayPresent:observed.overlay?.present??null,rateLimited:observed.rate_limit?.detected??null,draftReady:readiness.ready===true,compiledNegativeCases:4,readOnly:true,submitCalls:0};
console.log(JSON.stringify(result));
assert.equal(result.targetId,targetId);
assert.equal(result.port,port);
assert.equal(result.exactRoot,true);
assert.equal(result.composerEmpty,true);
assert.equal(result.composerVisible,true);
assert.equal(result.messageCount,0);
assert.equal(result.overlayPresent,false);
assert.equal(result.rateLimited,false);
assert.equal(result.authenticated,true);
assert.equal(result.targetSessionProof,true);
assert.equal(result.draftReady,true);
'@ $TargetId
exit $LASTEXITCODE
