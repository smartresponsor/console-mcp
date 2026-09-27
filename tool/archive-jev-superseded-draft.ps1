param(
    [string]$Source = "tool/fixture/jev-real-challenger-draft-superseded.json",
    [string]$Destination = "var/cache/jev/superseded/jev-real-challenger-draft-superseded.json"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sourcePath = Join-Path $repoRoot $Source
$destinationPath = Join-Path $repoRoot $Destination
$destinationDir = Split-Path -Parent $destinationPath

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Source file not found: $Source"
}

New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null

$notePath = Join-Path $destinationDir "README.md"
@"
# Superseded Jev drafts

This runtime/cache directory stores historical Jev draft artifacts that are not
active regression fixtures and should not be loaded by production or regression
tooling.

Canonical fixtures live under `tool/fixture/` and must be referenced explicitly
by tests or reports.
"@ | Set-Content -LiteralPath $notePath -Encoding UTF8

Move-Item -LiteralPath $sourcePath -Destination $destinationPath -Force

[pscustomobject]@{
    ok = $true
    source = $Source
    destination = $Destination
    note = "Archived superseded draft into ignored runtime/cache storage."
} | ConvertTo-Json -Depth 4
