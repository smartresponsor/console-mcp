param(
    [Parameter(Mandatory = $true)][string]$TargetId
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $escaped = $TargetId.Replace("'", "\'")
    $script = @"
import { resetPersistedComposerDraft } from "./dist/service/browser-session-executor.js";
const result = await resetPersistedComposerDraft({ ports: [9223], targetId: '$escaped', reloadAfterReset: false, timeoutMs: 10000 });
console.log(JSON.stringify(result));
if (result.ok !== true) process.exitCode = 1;
"@
    & node --input-type=module -e $script
    if ($LASTEXITCODE -ne 0) { throw "Composer reset failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
