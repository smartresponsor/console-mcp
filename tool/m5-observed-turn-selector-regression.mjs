import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/tool/chatgpt-message-capture.ts',import.meta.url),'utf8');
for(const name of ['buildMessageDomExpression','buildConversationStateExpression']){
 const start=source.indexOf('function '+name+'('),end=source.indexOf('\nasync function ',start+12);
 const body=source.slice(start,end<0?start+5500:end);
 assert(body.includes("legacy.length ? legacy : Array.from(document.querySelectorAll('main [data-user-message-bubble], main [data-response-body]'))"));
 assert(body.includes("node.hasAttribute('data-user-message-bubble') ? 'user'"));
 assert(body.includes("node.hasAttribute('data-response-body') ? 'assistant'"));
}
console.log('M5_OBSERVED_TURN_SELECTOR_FALLBACK_SOURCE_PASS');
