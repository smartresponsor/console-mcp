param([string]$Ref = 'HEAD', [ValidateSet('test','test:repository-worker-isolation','test:cmcp-go','test:deployment-preflight')][string]$Suite = 'test:repository-worker-isolation', [switch]$OverlayRegression)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$temp = Join-Path $env:TEMP ('cmcp-test-' + [guid]::NewGuid().ToString('N'))
$added = $false
try {
  & git -C $repo worktree add --detach $temp $Ref
  if ($LASTEXITCODE -ne 0) { throw 'Worktree creation failed' }
  $added = $true
  $existingModules = Join-Path $repo 'node_modules'
  if (-not (Test-Path -LiteralPath $existingModules -PathType Container)) { throw 'Existing node_modules is missing' }
  New-Item -ItemType Junction -Path (Join-Path $temp 'node_modules') -Target $existingModules -ErrorAction Stop | Out-Null
  if ($OverlayRegression) { Copy-Item -LiteralPath (Join-Path $repo 'tool/chatgpt-cmcp-go-auto-dispatch-regression.mjs') -Destination (Join-Path $temp 'tool/chatgpt-cmcp-go-auto-dispatch-regression.mjs') -Force }
  if ($OverlayRegression) { Copy-Item -LiteralPath (Join-Path $repo 'src/engine/engine-core.ts') -Destination (Join-Path $temp 'src/engine/engine-core.ts') -Force }
  if ($OverlayRegression) { Copy-Item -LiteralPath (Join-Path $repo 'tool/console-mcp-regression.ps1') -Destination (Join-Path $temp 'tool/console-mcp-regression.ps1') -Force }
  if ($OverlayRegression) {
    $regression = Join-Path $temp 'tool/console-mcp-regression.ps1'
    $source = Get-Content -LiteralPath $regression -Raw
    $needle = '    if ($summary.rc_false_green.validation_results.suspicious_count -lt 1) {'
    $probe = '    Write-Output ("RC_FALSE_GREEN_DEBUG " + ($summary.rc_false_green | Select-Object ok, status, validation_results, readiness | ConvertTo-Json -Depth 12 -Compress))' + "`r`n" + $needle
    if (-not $source.Contains($needle)) { throw 'False-green assertion location changed' }
    [System.IO.File]::WriteAllText($regression, $source.Replace($needle, $probe))
  }
  Write-Output ('ISOLATED_WORKTREE ' + $temp)
  $previousExtraRoots = $env:CONSOLE_MCP_EXTRA_ALLOWED_ROOTS
  try {
    $env:CONSOLE_MCP_EXTRA_ALLOWED_ROOTS = if ([string]::IsNullOrWhiteSpace($previousExtraRoots)) { $temp } else { $previousExtraRoots + ';' + $temp }
    if ($Suite -eq 'test:cmcp-go') {
      & npm --prefix $temp run build
      if ($LASTEXITCODE -eq 0) {
        Push-Location $temp
        try { & node tool/chatgpt-cmcp-go-auto-dispatch-regression.mjs } finally { Pop-Location }
      }
    } else {
      & npm --prefix $temp run $Suite
    }
  } finally {
    $env:CONSOLE_MCP_EXTRA_ALLOWED_ROOTS = $previousExtraRoots
  }
  $testExit = $LASTEXITCODE
  Write-Output ('ISOLATED_TEST_EXIT ' + $testExit)
  if ($testExit -ne 0) { exit $testExit }
} finally {
  if ($added) {
    $modules = Join-Path $temp 'node_modules'
    if (Test-Path -LiteralPath $modules) { [System.IO.Directory]::Delete($modules) }
    & git -C $repo worktree remove --force $temp
    if ($LASTEXITCODE -ne 0) { Write-Warning ('Cleanup requires attention: ' + $temp) }
  }
}
