$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$env:BROWSER_MCP_CORE_DOMAIN_DEFINITIONS_PATH='/home/alex/smartresponse/mcp/looping/.worktrees/browsing-startup-ingress-20261127/mcp-server/src/web-domain-tool-definitions.cjs'
Push-Location $root
try {
    foreach ($script in @('browsing-offline-build-regression.ps1','browsing-pair-admission-regression.ps1','browsing-pair-seal-regression.ps1','browsing-pair-runtime-regression.ps1','browsing-pair-cutover-regression.ps1','browsing-pair-live-witness-regression.ps1','browsing-pair-publication-regression.ps1','browsing-pair-lifecycle-regression.ps1')) {
        & pwsh -NoProfile -File (Join-Path $PSScriptRoot $script)
        if ($LASTEXITCODE -ne 0) { throw "PAIR_REGRESSION_FAILED $script" }
    }
    & pwsh -NoProfile -File tool/paired-web-dispatch-regression.ps1 -BrowsingRoot '/home/alex/smartresponse/mcp/looping/.worktrees/browsing-startup-ingress-20261127'
    if ($LASTEXITCODE -ne 0) { throw 'PAIRED_DISPATCH_FAILED' }
    & pwsh -NoProfile -File tool/runtime-tool-ingress-regression.ps1 -SkipBuild
    if ($LASTEXITCODE -ne 0) { throw 'INGRESS_FAILED' }
    & pwsh -NoProfile -File tool/chat-prompt-screenshot-consolidated-regression.ps1
    if ($LASTEXITCODE -ne 0) { throw 'SCREENSHOT_FAILED' }
    Write-Output 'PAIRED_CONSOLE_CONSOLIDATION_REGRESSION_PASS'
} finally { Pop-Location }
