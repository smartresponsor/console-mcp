import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const s=readFileSync(new URL('../src/tool/chatgpt-message-capture.ts',import.meta.url),'utf8');
assert(s.includes('const staticEffortLabel = '));
assert(s.includes('return !staticEffortLabel && text.length > 0'));
const label=/^(thinking effort|reasoning effort)(\s*[:/\-]\s*|\s+)(instant|standard|extended|light|heavy|medium|high|low)$/i;
for(const text of ['Thinking effort / Instant','Thinking effort: High','Reasoning effort - Medium'])assert(label.test(text));
for(const text of ['Thinking','Thinking through the problem','Searching the web'])assert(!label.test(text));
console.log('M5_STATIC_EFFORT_STATUS_EXCLUSION_PASS');
