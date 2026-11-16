param(
  [Parameter(Mandatory=$true)][string]$TargetId,
  [Parameter(Mandatory=$true)][string]$ChatId
)
$ErrorActionPreference='Stop'
& node (Join-Path $PSScriptRoot 'm5-dom-selector-readonly.mjs') $TargetId $ChatId
if($LASTEXITCODE -ne 0){throw 'M5_DOM_DIAGNOSTIC_FAILED'}
