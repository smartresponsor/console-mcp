const [target, chat] = process.argv.slice(2);
if (!/^[0-9a-f]{32}$/i.test(target ?? '') || !/^[0-9a-f-]{36}$/i.test(chat ?? '')) throw Error('M5_EXPLICIT_TARGET_CHAT_REQUIRED');
const targets=await (await fetch('http://127.0.0.1:9224/json/list',{signal:AbortSignal.timeout(3000)})).json();
const selected=targets.find(x=>x.id?.toUpperCase()===target);
if(!selected||!selected.url?.endsWith('/'+chat))throw Error('TARGET_CHAT_BINDING_MISMATCH');
const ws=new WebSocket(selected.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
const expression=`(() => {
 const selectors=['main [data-user-message-bubble]','main [data-response-body]','[data-message-author-role]','[data-testid^="conversation-turn-"]','article','main [role="article"]','main [data-testid*="message"]','main [data-testid*="turn"]'];
 const info=selectors.map(selector=>({selector,count:document.querySelectorAll(selector).length,
 sample:[...document.querySelectorAll(selector)].slice(-3).map(n=>({tag:n.tagName,role:n.getAttribute('role'),testid:n.getAttribute('data-testid'),author:n.getAttribute('data-message-author-role'),className:String(n.className||'').slice(0,130),textLength:String(n.innerText||'').length,textPreview:String(n.innerText||'').slice(0,100)}))}));
 const main=document.querySelector('main');const leaf=[...(main?.querySelectorAll('*')||[])].filter(n=>n.children.length===0&&/VIKUNJING_M5_CHAT_BOUND_OK|VIKUNJING M5 BROWSER ADMISSION SMOKE TEST/.test(n.textContent||'')).slice(-6).map(n=>({tag:n.tagName,outer:n.outerHTML.slice(0,280),parents:Array.from({length:9},(_,i)=>{let p=n;for(let j=0;j<=i;j++)p=p?.parentElement;return p}).filter(Boolean).map(p=>({tag:p.tagName,testid:p.getAttribute('data-testid'),role:p.getAttribute('role'),className:String(p.className||'').slice(0,110),dataKeys:[...p.attributes].filter(a=>a.name.startsWith('data-')).map(a=>a.name).slice(0,8)}))}));
 return {href:location.href,info,leaf};})()`;
const result=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('CDP_TIMEOUT')),4000);ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id===1){clearTimeout(timeout);resolve(m)}});ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:false}}))});
ws.close();
if(result.error||result.result?.exceptionDetails)throw Error('CDP_EVALUATE_FAILED');
console.log(JSON.stringify(result.result?.result?.value));
