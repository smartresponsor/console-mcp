# Read-only structural regression: a release selection must fail before
# existing runtime reuse, stop, or process start until broker receipts exist.
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'dev-console.d/53-runtime-control.ps1') -Raw
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Runtime control source has PowerShell parse errors.' }
$fn = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Start-UnifiedConsoleRuntime'
}, $true)
if (-not $fn) { throw 'Unified runtime launcher function not found.' }
$body = $fn.Extent.Text
$guard = $body.IndexOf('Explicit release selection is disabled until watchdog transaction receipts are implemented.')
$reuse = $body.IndexOf('if ($chatgptState.running -and $chatgptState.port_open')
$stop = $body.IndexOf('Stop-UnifiedConsoleRuntime | Out-Null')
$start = $body.IndexOf('Start-ManagedProcess -Spec $spec')
if ($guard -lt 0 -or $reuse -lt 0 -or $stop -lt 0 -or $start -lt 0) {
    throw 'Expected runtime guard or lifecycle statement not found.'
}
if ($guard -ge $reuse -or $guard -ge $stop -or $guard -ge $start) {
    throw 'Release selection guard occurs after a lifecycle operation.'
}
Write-Output 'RELEASE_LAUNCH_GUARD_REGRESSION_PASS'
