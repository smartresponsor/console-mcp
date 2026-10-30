[CmdletBinding()]
param([ValidateSet('routing','version')][string]$Suite = 'routing')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$scriptName = if ($Suite -eq 'routing') { 'runtime-broker-route-regression.mjs' } else { 'runtime-version-transaction-regression.mjs' }
[pscustomobject]@{
    phase = 'isolated-regression'
    suite = $Suite
    pid = $PID
    sessionId = if ($IsWindows) { [Diagnostics.Process]::GetCurrentProcess().SessionId } else { $null }
    productionControlRequested = $false
} | ConvertTo-Json -Compress
Push-Location $root
try {
    & node (Join-Path $PSScriptRoot $scriptName)
    $result = $LASTEXITCODE
} finally { Pop-Location }
exit $result
