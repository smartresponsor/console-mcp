# Read-only service snapshot; never restart or alter systemd units.
$ErrorActionPreference = 'Stop'
$units = @('console-mcp.service','console-mcp-browser.service','browser-mcp-worker.service','browser-mcp-visible-worker.service','console-mcp-desktop-agent.service')
$items = @()
foreach ($unit in $units) {
  $props = @{}
  $output = @(systemctl show $unit --no-pager -p LoadState -p ActiveState -p SubState -p MainPID -p Result -p FragmentPath 2>$null)
  foreach ($line in $output) {
    $pair = $line -split '=',2
    if ($pair.Count -eq 2) { $props[$pair[0]] = $pair[1] }
  }
  $items += [pscustomobject]@{ unit=$unit; load=$props.LoadState; active=$props.ActiveState; sub=$props.SubState; pid=$props.MainPID; result=$props.Result }
}
[pscustomobject]@{ok=$true;status='POST_REBOOT_SERVICE_INSPECTION';services=@($items)} | ConvertTo-Json -Compress -Depth 4
