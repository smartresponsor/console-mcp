$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $script = @'
import assert from "node:assert/strict";
import { resolveDraftSettleRetryDelayMs } from "./dist/service/browser-session-executor.js";
assert.equal(resolveDraftSettleRetryDelayMs("INPUT_FOCUS_BLOCKED", 400), 1200);
assert.equal(resolveDraftSettleRetryDelayMs("INPUT_FOCUS_BLOCKED", 1600), 1600);
assert.equal(resolveDraftSettleRetryDelayMs("COMPOSER_NOT_READY", 400), 400);
console.log(JSON.stringify({ ok: true, status: "DRAFT_SETTLE_RETRY_POLICY_GREEN" }));
'@
    & node --input-type=module -e $script
    if ($LASTEXITCODE -ne 0) { throw "Node regression failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
