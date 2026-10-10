$ErrorActionPreference = 'Stop'
$result = Invoke-Pester -Path (Join-Path $PSScriptRoot '../tests/pester') -PassThru
if ($result.FailedCount -gt 0) { exit 1 }
