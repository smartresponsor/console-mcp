$ErrorActionPreference = 'Stop'
$pidText = '60219'
$cg = Get-Content -LiteralPath "/proc/$pidText/cgroup" -ErrorAction Stop
$status = Get-Content -LiteralPath "/proc/$pidText/status" -ErrorAction Stop
$environBytes = [IO.File]::ReadAllBytes("/proc/$pidText/environ")
$environ = [Text.Encoding]::UTF8.GetString($environBytes).Split([char]0)
$safe = $environ | Where-Object { $_ -match '^(DISPLAY|XAUTHORITY|XDG_SESSION_TYPE|XDG_RUNTIME_DIR)=' }
$agent = Get-Content -LiteralPath '/home/alex/smartresponse/mcp/console-mcp/ops/ubuntu/script/desktop-session-agent.py' -ErrorAction Stop
[pscustomobject]@{cgroup=$cg;display=$safe;uid=(@($status | Where-Object { $_ -match '^Uid:' }) -join '');agentFocusSupported=([string]::Join([Environment]::NewLine,$agent).Contains("'verify-background', 'focus'"))} | ConvertTo-Json -Compress
