import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/tool/chatgpt-message-capture.ts',import.meta.url),'utf8');
const target='F60B5DBF7304A27AD7D4DDC05FDE5E03',chat='6afa61bc-fad0-83ea-8cb9-cdba1ac0a043';
const targets=await(await fetch('http://127.0.0.1:9224/json/list',{signal:AbortSignal.timeout(3000)})).json();
const selected=targets.find(x=>x.id?.toUpperCase()===target);
assert(selected?.url?.endsWith('/'+chat),'M5_TARGET_CHAT_BINDING_MISMATCH');
const ws=new WebSocket(selected.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
async function evaluate(expression,id){const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP_TIMEOUT')),6000);const handler=e=>{const m=JSON.parse(e.data);if(m.id!==id)return;ws.removeEventListener('message',handler);clearTimeout(timer);resolve(m)};ws.addEventListener('message',handler);ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:false}}))});if(result.error||result.result?.exceptionDetails)throw Error('CDP_EXPRESSION_ERROR:'+JSON.stringify(result.result?.exceptionDetails));return result.result?.result?.value}
function expression(name){const i=source.indexOf('function '+name+'(maxMessages: number): string { return `');assert(i>=0);const start=i+source.slice(i).indexOf('`')+1;const end=source.indexOf('`; }',start);assert(end>start);const raw=source.slice(start,end);return raw.replaceAll('${maxMessages}','8')}
try{
 const captured=await evaluate(expression('buildMessageDomExpression'),101);
 const state=await evaluate(expression('buildConversationStateExpression'),102);
 const slim={capture:captured,conversationMessages:state?.messages,composerActionMode:state?.composerActionMode,animatedStatusMode:state?.animatedStatusMode,generating:state?.generating,toolBusy:state?.toolBusy};
 console.log(JSON.stringify(slim));
 assert(Array.isArray(captured)&&captured.some(x=>x.role==='user'&&x.text.includes('VIKUNJING M5 BROWSER ADMISSION SMOKE TEST')));
 assert(captured.some(x=>x.role==='assistant'&&x.text.includes('VIKUNJING_M5_CHAT_BOUND_OK')));
 assert(Array.isArray(state?.messages)&&state.messages.some(x=>x.role==='assistant'&&x.text.includes('VIKUNJING_M5_CHAT_BOUND_OK')));
 console.log('M5_REAL_NATIVE_EXPRESSIONS_READONLY_PASS');
}finally{ws.close()}
