# Runs the strictly read-only grants CDP parallel acceptance with Node built-in WebSocket.
$ErrorActionPreference = 'Stop'
if (-not $IsLinux) { throw 'Linux only' }
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'tool/grants-worker-dom-acceptance.mjs'
$unit = & systemctl show console-mcp-grants-browser.service --property=ActiveState --property=SubState --property=User --property=MainPID --no-pager
$meta = @{}
foreach ($line in $unit) {
  if ($line -match '^([A-Za-z]+)=(.*)$') { $meta[$Matches[1]] = $Matches[2] }
}
if ($meta.ActiveState -ne 'active' -or $meta.User -ne 'console-mcp-grants') {
  [pscustomobject]@{ ok=$false; status='GRANT_SERVICE_METADATA_NOT_READY'; activeState=$meta.ActiveState; user=$meta.User } | ConvertTo-Json -Compress
  exit 1
}
if (-not (Test-Path -LiteralPath $script)) { throw 'GRANTS_CDP_ACCEPTANCE_MISSING' }
& node -- $script
if ($LASTEXITCODE -ne 0) { throw 'GRANTS_CDP_ACCEPTANCE_FAILED' }
[pscustomobject]@{
  ok = $true
  serviceActive = $meta.ActiveState
  serviceUser = $meta.User
  serviceMainPid = [int]$meta.MainPID
  noProductionBrowserChanges = $true
} | ConvertTo-Json -Compress
