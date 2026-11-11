param([ValidateSet("--write", "--check")][string]$Mode = "--check")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

    & node "tool/console-tool-admission-projection-cli.mjs" $Mode
    if ($LASTEXITCODE -ne 0) { throw "Admission projection failed with exit code $LASTEXITCODE" }


