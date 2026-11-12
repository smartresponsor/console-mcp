param([string]$LogPath = '', [int]$Tail = 200)
if (-not $LogPath) { $LogPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'var/transcript/oauth-debug.ndjson' }
$ErrorActionPreference = 'Stop'
if ($Tail -lt 1 -or $Tail -gt 2000) { throw 'Tail must be 1..2000' }
if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { throw 'OAuth debug log unavailable' }
$rows = @(Get-Content -LiteralPath $LogPath -Tail $Tail -ErrorAction Stop)
$parsed = @()
$invalid = 0
foreach ($line in $rows) {
  try {
    $item = $line | ConvertFrom-Json -ErrorAction Stop
    $parsed += [pscustomobject]@{ timestamp = $item.timestamp; result = $item.result; failure_stage = $item.failure_stage }
  } catch { $invalid++ }
}
$grouped = @($parsed | Group-Object result,failure_stage | ForEach-Object { [pscustomobject]@{ category = $_.Name; count = $_.Count } })
[pscustomobject]@{ sampled_lines = $rows.Count; parsed = $parsed.Count; invalid = $invalid; first_timestamp = $(if ($parsed.Count) { $parsed[0].timestamp } else { $null }); last_timestamp = $(if ($parsed.Count) { $parsed[-1].timestamp } else { $null }); grouped = $grouped } | ConvertTo-Json -Depth 5
