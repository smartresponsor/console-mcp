param([ValidateSet('probe','smoke','background','socket')][string]$Mode = 'probe')
$ErrorActionPreference = 'Stop'
if (-not $IsLinux) { throw 'Linux only' }
$port = 9230
function Get-Cdp([int]$Port) {
  try {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    $p = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2)
    return [pscustomobject]@{ ready=$true; instance=([Uri]$v.webSocketDebuggerUrl).AbsolutePath; pages=@($p | Where-Object type -eq 'page').Count }
  } catch { return [pscustomobject]@{ ready=$false; instance=$null; pages=$null } }
}
$before = [ordered]@{ '9223'=(Get-Cdp 9223); '9224'=(Get-Cdp 9224) }
if ($Mode -eq 'socket') {
  $rows = @()
  foreach ($table in @('tcp','tcp6')) {
    if (-not (Test-Path -LiteralPath "/proc/net/$table")) { continue }
    foreach ($line in @(Get-Content -LiteralPath "/proc/net/$table" | Select-Object -Skip 1)) {
      $cols = @($line.Trim() -split '\\s+')
      if ($cols.Count -lt 10) { continue }
      $local = $cols[1]
      if ($local -match ':2407$' -and $cols[3] -eq '0A') {
        $rows += [pscustomobject]@{ table=$table; local=$local; inode=$cols[9]; listen=$true }
      }
    }
  }
  [pscustomobject]@{ mode='socket'; port=9223; procNetTcpAvailable=(Test-Path '/proc/net/tcp'); procNetTcp6Available=(Test-Path '/proc/net/tcp6'); listenerMatches=$rows; count=$rows.Count; note='Read-only procfs; no process changes' } | ConvertTo-Json -Depth 5 -Compress
  exit 0
}
if ($Mode -eq 'background') {
  & node --experimental-strip-types ./tool/background-session-probe.mjs
  if ($LASTEXITCODE -ne 0) { throw 'BACKGROUND_PROBE_EXECUTION_FAILED' }
  exit 0
}
if ($Mode -eq 'probe') {
  [pscustomobject]@{ mode='probe'; baseline=$before; port9230Available=(-not (Get-Cdp $port).ready); noMutation=$true } | ConvertTo-Json -Depth 7 -Compress
  exit 0
}
if ((Get-Cdp $port).ready) { throw 'PORT_9230_OCCUPIED' }
if (-not $before['9223'].ready -or -not $before['9224'].ready) { throw 'LEGACY_BASELINE_UNHEALTHY' }
$edge = (Get-Command microsoft-edge-stable -ErrorAction Stop).Source
$profile = Join-Path ([IO.Path]::GetTempPath()) ('console-mcp-grants-smoke-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $profile -ErrorAction Stop
& chmod 700 -- $profile
$process = $null
$stopped = $false
try {
  $arguments = @(
    '--headless=new','--disable-gpu','--disable-dev-shm-usage','--no-first-run',
    '--no-default-browser-check','--no-sandbox', # Disposable about:blank smoke only; NEVER for authenticated production browser.
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$port","--user-data-dir=$profile",'about:blank'
  )
  $errorLog = Join-Path $profile 'edge-stderr.log'
  $process = Start-Process -FilePath $edge -ArgumentList $arguments -PassThru -RedirectStandardError $errorLog
  $grant = Get-Cdp $port
  for ($i=0; $i -lt 40 -and -not $grant.ready; $i++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { break }
    $grant = Get-Cdp $port
  }
  $during = [ordered]@{ '9223'=(Get-Cdp 9223); '9224'=(Get-Cdp 9224) }
  $unchanged = $true
  foreach ($p in @('9223','9224')) {
    if (-not $during[$p].ready -or $during[$p].instance -ne $before[$p].instance) { $unchanged = $false }
  }
  [pscustomobject]@{
    mode='smoke'; ok=($grant.ready -and $unchanged);
    grantEndpointReady=$grant.ready; grantPid=$process.Id; grantPages=$grant.pages;
    edgeStderrTail=$(if (Test-Path $errorLog) { @(Get-Content -LiteralPath $errorLog -Tail 8 -ErrorAction SilentlyContinue) } else { @() });
    legacyInstancesUnchanged=$unchanged; baseline=$before; during=$during;
  } | ConvertTo-Json -Depth 7 -Compress
} finally {
  if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
  for ($j=0; $j -lt 30; $j++) {
    if (-not (Get-Cdp $port).ready) { $stopped = $true; break }
    Start-Sleep -Milliseconds 200
  }
  $removed = $false
  if ($stopped) {
    try { Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction Stop; $removed=$true } catch { }
  }
  [pscustomobject]@{
    cleanup='GRANT_SMOKE_EXIT'; port9230Closed=$stopped; temporaryProfileRemoved=$removed;
    legacyAfter=[ordered]@{ '9223'=(Get-Cdp 9223); '9224'=(Get-Cdp 9224) }
  } | ConvertTo-Json -Depth 7 -Compress
}
