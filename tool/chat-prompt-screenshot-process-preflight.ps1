$ErrorActionPreference = 'Continue'
& id
& systemctl show console-mcp.service --property=ActiveState,MainPID,User,Group,ProtectProc,ProcSubset,NoNewPrivileges
& systemctl show console-mcp-browser.service --property=LoadState,ActiveState,MainPID,User,Group
& findmnt -n -o FSTYPE,OPTIONS /proc
Write-Output ('procNetTcpReadable=' + (Test-Path -LiteralPath /proc/net/tcp))
Write-Output ('procNetTcp6Readable=' + (Test-Path -LiteralPath /proc/net/tcp6))
& ss -ltn 'sport = :9223 or sport = :9224'
