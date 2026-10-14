$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$path = 'src/engine/engine-core.ts'
$stagedBefore = (& git -C $repo diff --cached --name-only)
if ($LASTEXITCODE -ne 0 -or $stagedBefore) { throw 'Index must be empty before partial staging' }
$diff = (& git -C $repo diff -- $path) -join "`n"
if ($LASTEXITCODE -ne 0 -or -not $diff.StartsWith('diff --git ')) { throw 'Missing expected engine diff' }
$blocks = [regex]::Split($diff, '(?m)(?=^@@ )')
$header = $blocks[0]
$selected = @($blocks | Select-Object -Skip 1 | Where-Object { $_ -match '(?m)^\+[^+].*(?:executionSpecificationHash|execution_specification_hash)' })
if ($selected.Count -ne 5) { throw ('Expected five hash-specific hunks; got ' + $selected.Count) }
$patch = $header + ($selected -join '')
$tmp = Join-Path $env:TEMP ('cmcp-hash-stage-' + [guid]::NewGuid().ToString('N') + '.patch')
try {
  [System.IO.File]::WriteAllText($tmp, $patch + "`n", [System.Text.UTF8Encoding]::new($false))
  & git -C $repo apply --cached --check $tmp
  if ($LASTEXITCODE -ne 0) { throw 'Partial index patch failed dry run' }
  & git -C $repo apply --cached $tmp
  if ($LASTEXITCODE -ne 0) { throw 'Partial index patch failed apply' }
  $verify = (& git -C $repo diff --cached -- $path) -join "`n"
  if ($verify -match 'management_state|setEngineManagementState|workerTick') { throw 'Forbidden management changes staged' }
  if (([regex]::Matches($verify, '(?m)^@@ ')).Count -ne 5) { throw 'Unexpected staged hunk count' }
  Write-Output $verify
} finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
