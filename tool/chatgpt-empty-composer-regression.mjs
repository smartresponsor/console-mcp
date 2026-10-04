import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { buildInputSnapshotExpression, inspectComposerPreflight } from '../dist/service/browser-session-executor.js';
const endpoint = process.env.CONSOLE_MCP_TEST_CDP_URL || 'http://127.0.0.1:9223';
const version = await (await fetch(endpoint + '/json/version')).json();
const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
let page;
try {
  page = await browser.contexts()[0].newPage();
  await page.setContent('<div contenteditable="true" role="textbox"><p><br></p></div>');
  const expression = buildInputSnapshotExpression();
  let result = await page.evaluate(expression);
  assert.equal(result.textLength, 0, 'Empty paragraph rendering must not block composer selection.');
  await page.locator('[contenteditable=true]').fill(' ');
  result = await page.evaluate(expression);
  assert.equal(result.textLength, 1, 'Actual whitespace draft must remain distinguishable from an empty placeholder.');
  await page.locator('[contenteditable=true]').fill('Keep this draft');
  result = await page.evaluate(expression);
  assert.equal(result.text, 'Keep this draft');
  assert.equal(result.textLength, 15, 'Nonempty drafts must retain overwrite protection.');
  console.log('Empty contenteditable placeholder and genuine drafts: PASS (Console-owned Edge, isolated test target).');
} finally { await page?.close(); await browser.close(); }
const preflight = await inspectComposerPreflight({ ports: [9223] });
console.log(JSON.stringify({ ok: preflight.ok, status: preflight.status, composer: preflight.composer, auth_state: preflight.auth_state }));
assert.equal(preflight.ok, true);
