import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectConsoleBearerForEndpoint } from '../dist/tool/ask.js';

const token = 'fixture-only-do-not-use-as-auth';
for (const address of [
  'http://127.0.0.1:3334/mcp',
  'http://localhost:3334/mcp',
]) {
  assert.equal(selectConsoleBearerForEndpoint(address, token), token, address);
}

for (const address of [
  'http://127.0.0.1:3333/mcp',
  'http://127.0.0.1:3335/mcp',
  'http://localhost:80/mcp',
  'https://127.0.0.1:3334/mcp',
  'http://127.0.0.2:3334/mcp',
  'http://example.com:3334/mcp',
  'http://localhost.evil.example:3334/mcp',
  'http://user:password@localhost:3334/mcp',
  'http://localhost:3334/mcp?leak=1',
  'http://localhost:3334/mcp#fragment',
  'http://localhost:3334/mcp/',
  'http://localhost:3334/other',
  'file:///tmp/mcp',
  'not-a-url',
]) {
  assert.equal(selectConsoleBearerForEndpoint(address, token), undefined, address);
}

assert.equal(selectConsoleBearerForEndpoint('http://127.0.0.1:3334/mcp', ''), undefined);
assert.equal(selectConsoleBearerForEndpoint('http://127.0.0.1:3334/mcp', '  '), undefined);
assert.equal(selectConsoleBearerForEndpoint('http://127.0.0.1:3334/mcp'), undefined);
const source = readFileSync(new URL('../src/tool/ask.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /CONSOLE_MCP_BEARER_TOKEN\s*:\s*[\"']\/secret\//);
assert.match(source, /RESOLVED_LOCAL_RUNTIME/);
console.log('ASK_LOOPBACK_BEARER_REGRESSION_PASS: 21 assertions, no secret values');
