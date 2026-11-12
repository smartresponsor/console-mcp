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
    $agent = [string]$x.user_agent
    $agentClass = if ($agent -match 'node|undici') { 'node' } elseif ($agent -match 'python|httpx|requests') { 'python' } elseif ($agent -match 'curl') { 'curl' } elseif ($agent -match 'Mozilla') { 'browser' } elseif (-not $agent) { 'missing' } else { 'other' }
    $parsed += [pscustomobject]@{ timestamp=$x.timestamp; method=$x.method; path=$x.path; status=$x.status_code; mode=$x.auth_mode; authorized=[bool]$x.has_authorization_header; agent_class=$agentClass }
  } catch { $invalid++ }
}
$groups = @($parsed | Group-Object mode,path,status,authorized,agent_class | ForEach-Object { [pscustomobject]@{ category=$_.Name; count=$_.Count } })
$oauth401 = @($parsed | Where-Object { $_.mode -eq 'oauth' -and $_.status -eq 401 } | Select-Object timestamp,method,agent_class)
[pscustomobject]@{ sampled_lines=$rows.Count; parsed=$parsed.Count; invalid=$invalid; first_timestamp=$(if($parsed.Count){$parsed[0].timestamp}else{$null}); last_timestamp=$(if($parsed.Count){$parsed[-1].timestamp}else{$null}); grouped=$groups; oauth401=$oauth401 } | ConvertTo-Json -Depth 5
