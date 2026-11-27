$ErrorActionPreference = 'Continue'
$line = @(& /usr/bin/ss -H -ltnpe 'sport = :9223' 2>$null)
$line | Write-Output
if ($line.Count -ne 1 -or $line[0] -notmatch 'pid=(\d+),fd=(\d+)') { throw 'SOCKET_OWNER_UNAVAILABLE' }
$browserPid = $Matches[1]; $browserFd = $Matches[2]
foreach ($item in @('stat','status','cgroup','cmdline','exe',"fd/$browserFd")) {
  $path = "/proc/$browserPid/$item"
  if ($item -eq 'exe' -or $item.StartsWith('fd/')) { & readlink $path; Write-Output "readlink:$item exit=$LASTEXITCODE" }
  elseif ($item -eq 'cmdline') {
    try { $raw=[IO.File]::ReadAllText($path); Write-Output ('cmdlineReadable=true length=' + $raw.Length + ' edge=' + ($raw -match 'msedge') + ' portFlag=' + ($raw -match 'remote-debugging-port=9223') + ' profileFlag=' + ($raw -match '/var/lib/console-mcp-browser/edge-profile')) } catch { Write-Output 'cmdlineReadable=false' }
  } elseif ($item -eq 'status') { & grep -E '^(Name|Uid|Gid):' $path }
  else { & cat $path }
}
