param([Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{32}$')][string]$TargetId)
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'visible-session-identity-diagnostic.mjs') $TargetId
exit $LASTEXITCODE
