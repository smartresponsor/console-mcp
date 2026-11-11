$ErrorActionPreference = 'Stop'
$services = @('console-mcp.service', 'console-mcp-visible-worker.service', 'console-mcp-browser.service')
$records = foreach ($service in $services) {
  $properties = @{}
  foreach ($line in @(& /usr/bin/systemctl show $service -p User -p Group -p MainPID -p ActiveState -p FragmentPath --no-pager)) {
    if ($line -match '^([^=]+)=(.*)$') { $properties[$Matches[1]] = $Matches[2] }
  }
  $pidText = [string]$properties['MainPID']
  $effectiveUid = $null
  if ($pidText -match '^[1-9][0-9]*$' -and (Test-Path -LiteralPath "/proc/$pidText/status")) {
    $uidLine = @(Get-Content -LiteralPath "/proc/$pidText/status" | Where-Object { $_ -match '^Uid:' }) | Select-Object -First 1
    if ($uidLine -match '^Uid:\s+(\d+)\s+(\d+)') { $effectiveUid = [int]$Matches[2] }
  }
  $declaredUid = $null
  if ($properties['User']) {
    $accountRecord = @(& /usr/bin/getent passwd $properties['User']) | Select-Object -First 1
    if ($accountRecord -match '^[^:]+:[^:]*:(\d+):') { $declaredUid = [int]$Matches[1] }
  }
  [pscustomobject]@{service=$service;active=$properties['ActiveState'];declaredUser=$properties['User'];declaredUid=$declaredUid;pid=$pidText;effectiveUid=$effectiveUid}
}
$records | ConvertTo-Json -Depth 4
