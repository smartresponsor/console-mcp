param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Cmcp = Join-Path $Root 'bin\cmcp.ps1'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$Tokens = $null
$Errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($Cmcp, [ref]$Tokens, [ref]$Errors) | Out-Null
Assert-True (@($Errors).Count -eq 0) 'bin/cmcp.ps1 has PowerShell parse errors'

if ($IsLinux) {
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'cmcp-linux-process-regression.ps1')
    Assert-True ($LASTEXITCODE -eq 0) 'Linux process/restart regression failed'
}

$Sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ('console-mcp-cli-' + [guid]::NewGuid().ToString('N'))
$Capture = Join-Path $Sandbox 'capture.ndjson'
$DevConsoleStub = Join-Path $Sandbox 'dev-console.ps1'
$AdoptStub = Join-Path $Sandbox 'adopt.ps1'
try {
    New-Item -ItemType Directory -Path $Sandbox -Force | Out-Null
    @'
param(
    [Parameter(Position = 0)][string]$Command,
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Remaining = @()
)
[pscustomobject]@{ command = $Command; arguments = @($Remaining) } | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:CMCP_REGRESSION_CAPTURE
if ($Command -eq 'doctor') { Write-Output 'CMCP_DOCTOR_STUB_READY' }
exit 0
'@ | Set-Content -LiteralPath $DevConsoleStub -Encoding UTF8
    "param([Parameter(ValueFromRemainingArguments=`$true)][string[]]`$Args)`nexit 0" | Set-Content -LiteralPath $AdoptStub -Encoding UTF8

    $env:CMCP_DEV_CONSOLE_PATH = $DevConsoleStub
    $env:CMCP_CHATGPT_LOOP_CLI_PATH = $AdoptStub
    $env:CMCP_REGRESSION_CAPTURE = $Capture

    $Doctor = & $Cmcp doctor 2>&1
    Assert-True ($LASTEXITCODE -eq 0) 'cmcp doctor failed'
    Assert-True (($Doctor -join "`n") -match 'CMCP_DOCTOR_STUB_READY') 'cmcp doctor did not use Console MCP dispatcher'

    & $Cmcp restart --check
    Assert-True ($LASTEXITCODE -eq 0) 'cmcp restart --check failed'

    & $Cmcp vendoring M13
    Assert-True ($LASTEXITCODE -eq 0) 'cmcp vendoring M13 failed'
    & $Cmcp go vendoring M13
    Assert-True ($LASTEXITCODE -eq 0) 'cmcp go vendoring M13 failed'
    & $Cmcp vendoring M13 --live
    Assert-True ($LASTEXITCODE -eq 0) 'cmcp vendoring M13 --live failed'
    $RedReport = Join-Path $Sandbox 'red-report.json'
    '{}' | Set-Content -LiteralPath $RedReport -Encoding UTF8
    & $Cmcp go vendoring M13 "--red-front=static-quality" "--red-report=$RedReport"
    Assert-True ($LASTEXITCODE -eq 0) 'cmcp go vendoring M13 --red-report failed'

    $Rows = @(Get-Content -LiteralPath $Capture | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-True ($Rows.Count -eq 6) 'expected doctor, restart, and four component dispatch records'
    Assert-True ($Rows[1].command -eq 'restart-server') 'cmcp restart did not use restart-server lifecycle dispatch'
    Assert-True ((@($Rows[1].arguments) -join '|') -eq '--check') 'cmcp restart did not forward --check'
    $Direct = $Rows[2]
    $Alias = $Rows[3]
    $ExplicitLive = $Rows[4]
    $RedEvidence = $Rows[5]
    Assert-True (($Direct | ConvertTo-Json -Compress) -eq ($Alias | ConvertTo-Json -Compress)) 'direct and go forms do not share identical dispatch arguments'
    Assert-True ($Direct.command -eq 'engine') 'component command did not use dev-console engine dispatcher'
    Assert-True ((@($Direct.arguments) -join '|') -eq 'go|vendoring|--max-auto-iterations=13|--live') 'canonical engine arguments are incorrect'
    Assert-True ((@($ExplicitLive.arguments | Where-Object { $_ -eq '--live' })).Count -eq 1) '--live was duplicated'
    Assert-True ((@($RedEvidence.arguments) -contains '--red-front=static-quality')) '--red-front was not forwarded intact'
    Assert-True ((@($RedEvidence.arguments) -contains "--red-report=$RedReport")) '--red-report was not forwarded intact'
    Assert-True ((@($RedEvidence.arguments | Where-Object { $_ -eq '--live' })).Count -eq 1) '--live was not added exactly once for red-report dispatch'

    & $Cmcp adopt fixture M1 'https://fixture.invalid'
    Assert-True ($LASTEXITCODE -eq 0) 'explicit adoption delegate override failed'
    Remove-Item Env:CMCP_CHATGPT_LOOP_CLI_PATH
    foreach ($directoryName in @('Looping','looping')) {
        $parent = Join-Path $Sandbox ('default-' + $directoryName)
        $fixtureCli = Join-Path $parent 'console/bin/cmcp.ps1'
        $delegate = Join-Path $parent ($directoryName + '/bin/cmcp.ps1')
        New-Item -ItemType Directory -Path (Split-Path $fixtureCli),(Split-Path $delegate) -Force | Out-Null
        Copy-Item -LiteralPath $Cmcp -Destination $fixtureCli
        "param([Parameter(ValueFromRemainingArguments=`$true)][string[]]`$Args)`nWrite-Output 'DEFAULT_ADOPTION_READY'`nexit 0" | Set-Content -LiteralPath $delegate -Encoding UTF8
        $output = & pwsh -NoProfile -File $fixtureCli adopt fixture M1 'https://fixture.invalid'
        Assert-True ($LASTEXITCODE -eq 0) "default adoption failed with $directoryName casing"
        Assert-True (($output -join "`n") -match 'DEFAULT_ADOPTION_READY') 'default adoption did not reach the sibling delegate'
    }

    [pscustomobject]@{
        ok = $true
        status = 'CMCP_CLI_REGRESSION_PASSED'
        canonical_dispatch = @($Direct.arguments)
        equivalent = $true
        live_added_once = $true
    } | ConvertTo-Json -Depth 8
} finally {
    Remove-Item Env:CMCP_DEV_CONSOLE_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:CMCP_CHATGPT_LOOP_CLI_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:CMCP_REGRESSION_CAPTURE -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Sandbox -Recurse -Force -ErrorAction SilentlyContinue
}
