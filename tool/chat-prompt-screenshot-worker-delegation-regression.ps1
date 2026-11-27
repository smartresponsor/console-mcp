$ErrorActionPreference = 'Stop'
$worker = '/home/alex/smartresponse/mcp/looping/.worktrees/browsing-shared-lease-20261127/playwright-worker/src/worker.js'
& node --check $worker
if ($LASTEXITCODE -ne 0) { throw 'WORKER_SYNTAX_FAILED' }
& node tool/chat-prompt-screenshot-worker-delegation-regression.mjs $worker
if ($LASTEXITCODE -ne 0) { throw 'WORKER_DELEGATED_LEASE_FAILED' }
