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
const diagnostic=readFileSync(new URL('./m5-dom-selector-readonly.mjs',import.meta.url),'utf8');
const wrapper=readFileSync(new URL('./m5-dom-selector-readonly.ps1',import.meta.url),'utf8');
assert(diagnostic.includes('process.argv.slice(2)'));
assert(diagnostic.includes('M5_EXPLICIT_TARGET_CHAT_REQUIRED'));
assert(wrapper.includes('Parameter(Mandatory=$true)'));
assert(!diagnostic.includes('F60B5DBF7304A27AD7D4DDC05FDE5E03'));
assert(!diagnostic.includes('6afa61bc-fad0-83ea-8cb9-cdba1ac0a043'));
console.log('M5_OBSERVED_TURN_SELECTOR_FALLBACK_SOURCE_PASS');
