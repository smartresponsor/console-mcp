param(
    [string] $Root = (Resolve-Path (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '..\..')).Path,
    [int] $MaxDepth = 4,
    [switch] $Apply
)
$ErrorActionPreference = 'Stop'
$excluded = @('.git','node_modules','vendor','.venv','var','dist','build','.idea','.console-mcp','_quarantine')
$workflow = @'
name: Security
on:
  pull_request:
  push:
    branches: [master, main]
  workflow_dispatch:
  schedule:
    - cron: '23 5 * * 2'

permissions:
  contents: read

jobs:
  security:
    uses: smartresponsor/console-mcp/.github/workflows/security-reusable.yml@master
'@
$repos = Get-ChildItem -LiteralPath $Root -Directory -Depth $MaxDepth -Force |
    Where-Object {
        $parts = $_.FullName.Substring($Root.Length).TrimStart('\').Split('\')
        -not ($parts | Where-Object { $excluded -contains $_ }) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName '.git'))
    } | Select-Object -ExpandProperty FullName -Unique | Sort-Object
$results = @()
$seenOrigins = @{}
foreach ($repo in $repos) {
    $origin = (& git -C $repo remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or $origin -notmatch '(?i)smartresponsor[/:]') { continue }
    $originKey = (($origin.Trim() -replace '\.git$','') -replace '^git@github\.com:','https://github.com/').ToLowerInvariant()
    if ($seenOrigins.ContainsKey($originKey)) { continue }
    $seenOrigins[$originKey] = $repo
    $target = Join-Path $repo '.github/workflows/security.yml'
    $status = 'missing'
    if (Test-Path -LiteralPath $target) {
        $existing = Get-Content -LiteralPath $target -Raw
        $status = if ($existing -match 'smartresponsor/console-mcp/.github/workflows/security-reusable.yml@master') { 'installed' } else { 'conflict_existing_workflow' }
    } elseif ($Apply) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Set-Content -LiteralPath $target -Value $workflow -Encoding utf8
        $status = 'installed_now'
    }
    $results += [ordered]@{ repository = $repo; origin = $origin.Trim(); status = $status }
}
$summary = [ordered]@{
    root = $Root
    apply = [bool]$Apply
    repository_count = $results.Count
    installed_count = @($results | Where-Object { $_.status -in @('installed','installed_now') }).Count
    installed_now_count = @($results | Where-Object { $_.status -eq 'installed_now' }).Count
    missing_count = @($results | Where-Object { $_.status -eq 'missing' }).Count
    conflict_count = @($results | Where-Object { $_.status -eq 'conflict_existing_workflow' }).Count
    results = $results
}
$summary | ConvertTo-Json -Depth 6
if ($summary.conflict_count -gt 0) { exit 2 }
