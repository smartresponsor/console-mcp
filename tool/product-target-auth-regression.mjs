import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {classifyChatGptAuthState} from '../src/Consumer/ChatGpt/Session/ChatGptSessionClassifier.ts';
import {buildChatGptTargetAuthProbeExpression} from '../src/Consumer/ChatGpt/Session/ChatGptTargetAuthProbe.ts';
const url='https://chatgpt.com/';
test('unknown without proof, true with proof, explicit login wins',()=>{
 assert.equal(classifyChatGptAuthState({url,visibleText:'Recents'}).authenticated,'unknown');
 assert.equal(classifyChatGptAuthState({url,visibleText:'Recents',targetSessionAuthenticated:true}).authenticated,true);
 assert.equal(classifyChatGptAuthState({url,visibleText:'Log in',targetSessionAuthenticated:true}).authenticated,false);
 assert.equal(classifyChatGptAuthState({url,visibleText:'Recents',targetSessionAuthenticated:false}).authenticated,'unknown');
});
test('probe returns boolean only, exact visible origin and no navigation drift',async()=>{
 const make=({href=url,focus=true,status=200,expires=new Date(Date.now()+60000).toISOString(),drift=false,fail=false,guest=false}={})=>{
  let calls=0;const location={origin:new URL(href).origin,href};
  const fetch=async(path,init)=>{
   calls++;assert.equal(path,'/api/auth/session');assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'error');
   if(fail)throw Error('network');
   if(drift)location.href='https://chatgpt.com/c/other';
   return {ok:status===200,json:async()=>guest?{}:{user:{private:'not returned'},expires,accessToken:'not returned'}};
  };
  return {context:{location,document:{visibilityState:'visible',hasFocus:()=>focus},fetch,AbortSignal,Date},count:()=>calls};
 };
 for(const [opts,expected,count] of [[{},true,1],[{guest:true},false,1],[{expires:'2000-01-01'},false,1],[{status:401},false,1],[{fail:true},false,1],[{drift:true},false,1],[{focus:false},false,0],[{href:'https://example.invalid/'},false,0]]){
  const m=make(opts);const r=await vm.runInNewContext(buildChatGptTargetAuthProbeExpression(url),m.context);
  assert.equal(JSON.stringify(r),JSON.stringify({authenticated:expected}));assert.equal(m.count(),count);
 }
});
test('executor passes exact target proof only for unknown empty fresh root',async()=>{
 const s=await readFile(new URL('../src/service/browser-session-executor.ts',import.meta.url),'utf8');
 assert.match(s,/initialAuth\.authenticated === "unknown" && result\.href === "https:\/\/chatgpt\.com\/"[\s\S]{0,350}composer\.textLength === 0/);
 assert.match(s,/safeEvaluateInTarget\(target\.web_socket_debugger_url,\s*buildChatGptTargetAuthProbeExpression/);
 assert.match(s,/preflight\.target_id === target\.id\s*&& preflight\.href === target\.url/);
});
