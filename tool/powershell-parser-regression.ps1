# Parse all runtime control modules without dot-sourcing or executing them.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$targets = @(
  (Join-Path $PSScriptRoot 'dev-console.ps1')
  (Join-Path $PSScriptRoot 'runtime-release-plan.ps1')
  (Join-Path $PSScriptRoot 'runtime-deployment-preflight.ps1')
)
$targets += @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'dev-console.d') -Filter '*.ps1' -File | Select-Object -ExpandProperty FullName)
$failures = @()
foreach ($file in $targets) {
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$parseErrors)
  foreach ($parseError in @($parseErrors)) {
    $failures += "$file : $($parseError.Extent.StartLineNumber) : $($parseError.Message)"
  }
}
if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error $_ }
  exit 1
}
Write-Output "POWERSHELL_PARSER_REGRESSION_PASS ($($targets.Count) files)"
