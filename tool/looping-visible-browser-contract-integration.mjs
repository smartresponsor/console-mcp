import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const configured = process.env.LOOPING_VISIBLE_WORKER_SOURCE;
if (!configured) {
 console.error('LOOPING_CONTRACT_SOURCE_REQUIRED: set LOOPING_VISIBLE_WORKER_SOURCE to an existing genuine Looping worker source file. This integration gate is NOT part of autonomous npm test.');
 process.exit(2);
}
const sourcePath = resolve(configured);
const file = await stat(sourcePath);
assert(file.isFile(), 'LOOPING_CONTRACT_SOURCE_NOT_FILE');
const worker = await readFile(sourcePath,'utf8');
assert.match(worker,/if \(guard\?\.ok && !policy\.externalVisibleChrome\)/,'Verified Console target must reject independent browser ownership');
assert.match(worker,/if \(policy\.externalVisibleChrome\)/,'Visible browser must use external CDP attachment');
assert.match(worker,/if \(!browser\) \{[\s\S]*?chromium\.launchPersistentContext/,'Managed browser launch must remain separate from external CDP attachment');
assert.doesNotMatch(worker,/cdpBrowser\.newContext/,'CDP attachment must not create competing browser contexts');
assert.match(worker,/RECOVERY_REQUIRES_CONSOLE_ORCHESTRATION/);
assert.match(worker,/visibleRequest\.run\(\{ \.\.\.before, preserveActiveTarget \}, next\)/);
assert.match(worker,/requireApprovalForSubmit/);
assert.match(worker,/consumeApprovalReceipt/);
console.log('LOOPING_VISIBLE_BROWSER_CROSS_REPO_CONTRACT_PASS',sourcePath);
