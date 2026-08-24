param(
    [string] $Repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [switch] $NoHistory
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $Repository).Path
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw "Not a Git repository: $repo" }
$gitleaks = Get-Command gitleaks -ErrorAction Stop
$semgrep = Get-Command semgrep -ErrorAction Stop
$result = [ordered]@{ repository = $repo; gitleaks = $null; semgrep = $null; ok = $false }
Push-Location $repo
try {
    $gitleaksArgs = if ($NoHistory) { @('dir','--redact','--verbose','--no-banner','--no-color','.') } else { @('git','--redact','--verbose','--no-banner','--no-color','.') }
    $gitleaksOutput = & $gitleaks.Source @gitleaksArgs 2>&1
    $gitleaksExit = $LASTEXITCODE
    $result.gitleaks = [ordered]@{
        ok = ($gitleaksExit -eq 0)
        exit_code = $gitleaksExit
        output = (($gitleaksOutput | Select-Object -Last 80) -join "`n")
    }
    $semgrepOutput = & $semgrep.Source scan --config p/security-audit --metrics=off --error --exclude .git --exclude .venv --exclude vendor --exclude node_modules --exclude var --exclude dist --exclude build . 2>&1
    $semgrepExit = $LASTEXITCODE
    $result.semgrep = [ordered]@{
        ok = ($semgrepExit -eq 0)
        exit_code = $semgrepExit
        output = (($semgrepOutput | Select-Object -Last 120) -join "`n")
    }
    $result.ok = ($gitleaksExit -eq 0 -and $semgrepExit -eq 0)
} finally { Pop-Location }
$result | ConvertTo-Json -Depth 6
if (-not $result.ok) { exit 1 }
