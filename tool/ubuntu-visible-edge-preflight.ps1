# Read-only Linux Edge/session discovery; never print raw environments or credentials.
if (-not $IsLinux) { throw 'Linux only' }
$results = @()
foreach ($dir in @(Get-ChildItem /proc -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+$' })) {
  $pidText = $dir.Name
  try {
    $comm = [IO.File]::ReadAllText("/proc/$pidText/comm").Trim()
    if ($comm -notmatch '^(?:msedge|chrome|chromium|microsoft-edge(?:-stable)?)$') { continue }
    $cmd = [IO.File]::ReadAllText("/proc/$pidText/cmdline").Split([char]0, [StringSplitOptions]::RemoveEmptyEntries)
    if (@($cmd | Where-Object { $_ -like '--type=*' }).Count -gt 0) { continue }
    $status = [IO.File]::ReadAllText("/proc/$pidText/status")
    $uidValue = if ($status -match '(?m)^Uid:\s*(\d+)') { $Matches[1] } else { $null }
    $environ = @([IO.File]::ReadAllText("/proc/$pidText/environ").Split([char]0, [StringSplitOptions]::RemoveEmptyEntries))
    $vars = @{}
    foreach ($key in @('DISPLAY','WAYLAND_DISPLAY','XDG_SESSION_TYPE','XDG_RUNTIME_DIR')) {
      $entry = @($environ | Where-Object { $_.StartsWith("$key=") } | Select-Object -First 1)
      $vars[$key] = if ($entry.Count) { $entry[0].Substring($key.Length + 1) } else { $null }
    }
    $profile = @($cmd | Where-Object { $_ -match '^--user-data-dir=' } | Select-Object -First 1)
    $port = @($cmd | Where-Object { $_ -match '^--remote-debugging-port=' } | Select-Object -First 1)
    $results += [pscustomobject]@{
      pid = [int]$pidText; uid = $uidValue; executable = [IO.Path]::GetFileName($cmd[0]);
      display = $vars.DISPLAY; wayland_display = $vars.WAYLAND_DISPLAY;
      session_type = $vars.XDG_SESSION_TYPE; runtime_dir = $vars.XDG_RUNTIME_DIR;
      profile = if ($profile.Count) { $profile[0] -replace '^--user-data-dir=', '' } else { $null };
      debug_port = if ($port.Count) { $port[0] -replace '^--remote-debugging-port=', '' } else { $null }
    }
  } catch { continue }
}
[pscustomobject]@{ ok = $true; status = 'LINUX_BROWSER_PROCESS_INVENTORY'; browser_processes = @($results); process_count = $results.Count } | ConvertTo-Json -Depth 6 -Compress
