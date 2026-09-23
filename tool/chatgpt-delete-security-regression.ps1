$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$testPath = Join-Path $repositoryRoot 'tests/pester/chatgpt-delete-security.Tests.ps1'

$result = Invoke-Pester -Path $testPath -PassThru
if ($result.FailedCount -gt 0) {
    exit 1
}

[pscustomobject]@{
    ok = $true
    status = 'CHATGPT_DELETE_SECURITY_REGRESSION_GREEN'
    passed = [int]$result.PassedCount
    failed = [int]$result.FailedCount
    skipped = [int]$result.SkippedCount
} | ConvertTo-Json -Depth 4
