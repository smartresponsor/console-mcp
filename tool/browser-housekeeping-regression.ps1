$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$RunDir = Join-Path $Root 'var\run'
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

. (Join-Path $PSScriptRoot 'dev-console.d\45-watchdog-cadence.ps1')

$script:RefreshState = $null
function Get-ChatgptConnectorRefreshState { return $script:RefreshState }
function Sanitize-Text { param([string]$Text) return $Text }

. (Join-Path $PSScriptRoot 'dev-console.d\99-browser-housekeeping.ps1')

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) { throw "$Message Expected=$Expected Actual=$Actual" }
}

Assert-True -Condition ($DevConsoleBrowserHousekeepingModuleLoaded -eq $true) -Message 'housekeeping module load marker missing'

$definition = Get-WatchdogCadenceDefinition
Assert-Equal -Expected 5 -Actual $definition.runtime -Message 'runtime cadence changed'
Assert-Equal -Expected 600 -Actual $definition.browser_housekeeping -Message 'housekeeping default cadence mismatch'
Assert-Equal -Expected 600 -Actual $definition.build_fingerprint -Message 'build cadence changed'

$now = [datetime]::UtcNow
$emptyState = [pscustomobject]@{ lanes = [pscustomobject]@{} }
$script:RefreshState = [pscustomobject]@{ at = $now.AddSeconds(-30).ToString('o'); ok = $true; status = 'CONNECTOR_REFRESH_UI_CONFIRMED_SCHEMA_PENDING' }
Assert-True -Condition (-not (Test-WatchdogCadenceLaneDue -State $emptyState -Name 'browser_housekeeping' -IntervalSeconds 600 -Now $now)) -Message 'refresh grace was not respected'

$script:RefreshState = [pscustomobject]@{ at = $now.AddSeconds(-120).ToString('o'); ok = $true; status = 'CONNECTOR_REFRESH_UI_CONFIRMED_SCHEMA_PENDING' }
Assert-True -Condition (Test-WatchdogCadenceLaneDue -State $emptyState -Name 'browser_housekeeping' -IntervalSeconds 600 -Now $now) -Message 'refresh handoff did not make housekeeping due'

$handledState = [pscustomobject]@{
    lanes = [pscustomobject]@{
        browser_housekeeping = [pscustomobject]@{ completed_at = $now.AddSeconds(-30).ToString('o') }
    }
}
Assert-True -Condition (-not (Test-WatchdogCadenceLaneDue -State $handledState -Name 'browser_housekeeping' -IntervalSeconds 600 -Now $now)) -Message 'handled refresh incorrectly retriggered housekeeping'

$duplicateRejected = $false
try {
    Register-WatchdogCadenceLane -Name 'browser_housekeeping' -IntervalSeconds 600 -Invoke { $null }
} catch {
    $duplicateRejected = $_.Exception.Message -match 'already registered'
}
Assert-True -Condition $duplicateRejected -Message 'duplicate cadence lane registration was not rejected'

function Invoke-BrowserPluginSettingsHousekeeping {
    return [pscustomobject]@{ ok = $true; status = 'CHATGPT_PLUGIN_SETTINGS_HOUSEKEEPING_DONE' }
}
$healthy = Invoke-WatchdogCadenceLane -Name 'browser_housekeeping'
Assert-True -Condition $healthy.ok -Message 'healthy housekeeping lane not green'
Assert-True -Condition (-not $healthy.repair_required) -Message 'healthy housekeeping requested repair'

function Invoke-BrowserPluginSettingsHousekeeping {
    return [pscustomobject]@{ ok = $false; status = 'CHATGPT_PLUGIN_SETTINGS_HOUSEKEEPING_PARTIAL' }
}
$partial = Invoke-WatchdogCadenceLane -Name 'browser_housekeeping'
Assert-True -Condition (-not $partial.ok) -Message 'partial housekeeping incorrectly green'
Assert-True -Condition (-not $partial.repair_required) -Message 'partial housekeeping must never trigger watchdog heal'

[pscustomobject]@{
    ok = $true
    status = 'BROWSER_HOUSEKEEPING_REGRESSION_GREEN'
    cadence_seconds = $definition.browser_housekeeping
    refresh_grace_seconds = Get-BrowserHousekeepingRefreshGraceSeconds
    repair_isolation_confirmed = $true
} | ConvertTo-Json -Depth 10
