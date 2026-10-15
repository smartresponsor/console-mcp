# Read-only deployment preflight. No login, service, socket or browser mutation.
$ErrorActionPreference = 'Stop'
$sessions = @(loginctl list-sessions --no-legend 2>$null)
$items = @()
foreach ($line in $sessions) {
  $id = @($line.Trim() -split '\s+')[0]
  if (-not $id) { continue }
  $lines = @(loginctl show-session $id -p Id -p User -p Name -p Active -p Remote -p Class -p Type -p LockedHint 2>$null)
  $values = @{}
  foreach ($entry in $lines) {
    $parts = $entry -split '=', 2
    if ($parts.Count -eq 2) { $values[$parts[0]] = $parts[1] }
  }
  if ($values.Class -ne 'user') { continue }
  $uid = $values.User
  $socket = "/run/user/$uid/console-mcp-desktop-agent.sock"
  $socketPresent = $false
  $socketProbe = "not_found"
  try {
    $socketPresent = Test-Path -LiteralPath $socket -PathType Leaf -ErrorAction Stop
    if ($socketPresent) { $socketProbe = "exists" }
  } catch [System.UnauthorizedAccessException] {
    $socketProbe = "access_denied"
  } catch {
    $socketProbe = "unavailable"
  }
  $items += [pscustomobject]@{
    id = $values.Id; uid = $uid; user = $values.Name;
    active = $values.Active; remote = $values.Remote;
    type = $values.Type; locked = $values.LockedHint;
    agentSocketExists = [bool]$socketPresent; agentSocketProbe = $socketProbe
  }
}
[pscustomobject]@{ ok = $true; status = 'DESKTOP_DEPLOYMENT_PREFLIGHT'; sessions = @($items) } | ConvertTo-Json -Depth 5 -Compress
