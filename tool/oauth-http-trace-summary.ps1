param([string]$LogPath = '', [int]$Tail = 2000)
$ErrorActionPreference = 'Stop'
if (-not $LogPath) { $LogPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'var/transcript/http-trace.ndjson' }
if ($Tail -lt 1 -or $Tail -gt 5000) { throw 'Tail must be 1..5000' }
if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { throw 'HTTP trace unavailable' }
$rows = @(Get-Content -LiteralPath $LogPath -Tail $Tail)
$parsed = @(); $invalid = 0
foreach ($line in $rows) {
  try {
    $x = $line | ConvertFrom-Json -ErrorAction Stop
    $parsed += [pscustomobject]@{ timestamp=$x.timestamp; method=$x.method; path=$x.path; status=$x.status_code; mode=$x.auth_mode; authorized=[bool]$x.has_authorization_header }
  } catch { $invalid++ }
}
$groups = @($parsed | Group-Object mode,path,status,authorized | ForEach-Object { [pscustomobject]@{ category=$_.Name; count=$_.Count } })
[pscustomobject]@{ sampled_lines=$rows.Count; parsed=$parsed.Count; invalid=$invalid; first_timestamp=$(if($parsed.Count){$parsed[0].timestamp}else{$null}); last_timestamp=$(if($parsed.Count){$parsed[-1].timestamp}else{$null}); grouped=$groups } | ConvertTo-Json -Depth 5
