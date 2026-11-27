$ErrorActionPreference = 'Continue'
& systemctl show console-mcp-browser.service --property=ActiveState,SubState,Result,NRestarts,MainPID,ExecMainCode,ExecMainStatus,ActiveEnterTimestamp
& journalctl -u console-mcp-browser.service -n 25 --no-pager -o cat
