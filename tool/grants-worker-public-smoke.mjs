import assert from 'node:assert/strict';
// Public test only. Never navigate or attach to a legacy page.
const url='https://www.grants.gov/', ports=[9223,9224,9230];
const get=async(p,path)=>{const r=await fetch('http://127.0.0.1:'+p+path,{signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('HTTP_'+r.status);return r.json()};
const before=await Promise.all(ports.map(p=>get(p,'/json/version')));
const browserIds=before.map(x=>new URL(x.webSocketDebuggerUrl).pathname);
assert.equal(new Set(browserIds).size,3);
const original=await get(9230,'/json/list');
assert.equal(original.filter(t=>t.type==='page').length,1);
assert.equal(original.find(t=>t.type==='page')?.url,'about:blank');
function rpc(url){
  const u=new URL(url);assert.equal(u.protocol,'ws:');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'9230');
  const socket=new WebSocket(url);const pending=new Map();let current=0;
  const ready=new Promise((res,rej)=>{socket.addEventListener('open',res,{once:true});socket.addEventListener('error',()=>rej(Error('WS_CONNECT')),{once:true})});
  socket.addEventListener('message',ev=>{let m;try{m=JSON.parse(String(ev.data))}catch{return}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error('CDP_'+m.error.code)):p.resolve(m.result)});
  return {async call(method,params={}){await ready;const id=++current;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP_TIMEOUT'))},5500);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})},close(){try{socket.close()}catch{}}};
}
const browser=rpc(before[2].webSocketDebuggerUrl);
let targetId,page;
let result={ok:false,status:'GRANTS_PUBLIC_SITE_NOT_VERIFIED',workerId:'grants',site:'grants.gov'};
try{
  const created=await browser.call('Target.createTarget',{url:'about:blank'});
  targetId=created.targetId;assert.match(targetId,/^[A-F0-9]{32}$/i);
  const all=await get(9230,'/json/list');
  const t=all.find(t=>t.type==='page'&&t.id===targetId&&t.url==='about:blank');
  assert.ok(t,'new target missing from grants worker');
  page=rpc(t.webSocketDebuggerUrl);
  const nav=await page.call('Page.navigate',{url});assert.equal(nav.errorText,undefined);
  let observed;
  for(let i=0;i<22;i++){
    await new Promise(resolve=>setTimeout(resolve,500));
    const state=await page.call('Runtime.evaluate',{expression:'({origin:location.origin,ready:document.readyState,title:document.title,bodyPresent:!!document.body})',returnByValue:true});
    observed=state.result?.value;
    if(observed?.bodyPresent&&observed?.ready!=='loading')break;
  }
  const originAllowed=observed?.origin==='https://www.grants.gov'||observed?.origin==='https://grants.gov';
  result={ok:Boolean(originAllowed&&observed?.bodyPresent),status:originAllowed&&observed?.bodyPresent?'GRANTS_PUBLIC_DOM_REACHABLE':'GRANTS_PUBLIC_SITE_NOT_VERIFIED',workerId:'grants',site:'grants.gov',originAllowed,documentReady:observed?.ready??null,hasTitle:typeof observed?.title==='string'&&observed.title.length>0,mutationAttemptedOnLegacy:false};
}finally{
  page?.close();
  if(targetId)await browser.call('Target.closeTarget',{targetId}).catch(()=>{});
  browser.close();
  const after=await Promise.all(ports.map(p=>get(p,'/json/version')));
  result.instancesStable=after.every((v,i)=>new URL(v.webSocketDebuggerUrl).pathname===browserIds[i]);
  const finalTargets=await get(9230,'/json/list');
  result.createdTargetClosed=!finalTargets.some(t=>t.id===targetId);
  result.originalBlankPreserved=finalTargets.some(t=>t.type==='page'&&t.url==='about:blank');
  result.ok=Boolean(result.ok&&result.instancesStable&&result.createdTargetClosed&&result.originalBlankPreserved);
  console.log(JSON.stringify(result));
}
if(!result.ok)process.exitCode=1;
