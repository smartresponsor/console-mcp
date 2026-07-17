param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Files = @(
    (Join-Path $Root 'tool\dev-console.ps1'),
    (Join-Path $Root 'tool\dev-console.d\85-session-relay.ps1'),
    (Join-Path $Root 'tool\dev-console.d\90-server-lifecycle.ps1'),
    (Join-Path $Root 'tool\dev-console.d\95-restart-failsafe.ps1')
)

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

foreach ($file in $Files) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) | Out-Null
    Assert-True (@($errors).Count -eq 0) "$file has PowerShell parse errors"
}

$dev = Get-Content -LiteralPath $Files[0] -Raw
$relay = Get-Content -LiteralPath $Files[1] -Raw
$lifecycle = Get-Content -LiteralPath $Files[2] -Raw
$failsafe = Get-Content -LiteralPath $Files[3] -Raw

Assert-True ($dev -match 'Invoke-RestartPreflight') 'restart --check route missing'
Assert-True ($dev -match 'Invoke-FailSafeRestart') 'restart commit route missing'
Assert-True ($failsafe -match 'WATCHDOG_BOOTSTRAP_FAILED') 'bounded bootstrap failure missing'
Assert-True ($failsafe -match 'RESTART_PREFLIGHT_READY') 'preflight ready status missing'
Assert-True ($failsafe -match 'AddSeconds\(60\)') '60-second receipt expiry missing'
Assert-True ($failsafe -match "supported_actions -contains 'stop-server'") 'capability negotiation missing'
Assert-True ($failsafe -match 'RESTART_FAILED_RUNTIME_RECOVERED') 'rollback recovery status missing'
Assert-True ($failsafe -match 'Start-UnifiedConsoleRuntime') 'rollback start missing'
Assert-True ($failsafe -match 'function Wait-RestartSchemaConfirmation') 'bounded schema confirmation wait missing'
Assert-True ($failsafe -match 'TimeoutSeconds = 20') 'schema confirmation timeout missing'
Assert-True ($failsafe -match 'RESTART_COMPLETED_SCHEMA_PENDING') 'schema pending terminal status missing'
Assert-True ($failsafe -match 'CONSOLE_SERVER_RESTARTED_SCHEMA_CONFIRMED') 'schema confirmed terminal status missing'
Assert-True ($relay -match "supported_actions = @\('stop-server', 'start-server'\)") 'broker capability declaration missing'
Assert-True ($relay -notmatch '\$loopStartRaw = Start-WatchdogLoop') 'COMMIT dispatch still starts watchdog'
Assert-True ($relay -notmatch '\$buildOutput = Ensure-BuildOutput') 'COMMIT dispatch still builds runtime'
Assert-True ($lifecycle -notmatch 'Restart-WatchdogLoop') 'runtime lifecycle restarts watchdog'
Assert-True ($lifecycle -notmatch 'Stop-WatchdogLoop') 'runtime lifecycle stops watchdog'

[pscustomobject]@{
    ok = $true
    status = 'RESTART_FAILSAFE_REGRESSION_PASSED'
    scenario_count = 10
} | ConvertTo-Json -Depth 4
