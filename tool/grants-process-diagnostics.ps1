$ErrorActionPreference='Continue'
$meta=& systemctl show console-mcp-grants-browser.service --property=ActiveState --property=MainPID --property=User --no-pager
'UNIT=' + ($meta -join ',')
$pidNum=0
foreach($line in $meta){if($line -match '^MainPID=(\d+)$'){$pidNum=[int]$Matches[1]}}
try {$uid=(& id -u console-mcp-grants); 'SERVICE_UID='+$uid}catch{'UID_ERROR='+$_}
try{$s=[IO.File]::ReadAllText("/proc/$pidNum/cmdline");$args=$s.Split([char]0,[StringSplitOptions]::RemoveEmptyEntries);'CMD_ARGS='+($args -join ' | ')}catch{'CMDLINE_ERROR='+$_}
try{$item=Get-Item "/proc/$pidNum";'PROC_EXISTS='+[bool]$item}catch{'PROC_ERROR='+$_}
try {$r=Invoke-RestMethod 'http://127.0.0.1:9230/json/version' -TimeoutSec 3;'CDP_BROWSER_PATH='+([uri]$r.webSocketDebuggerUrl).AbsolutePath}catch{'CDP_ERROR='+$_}
try {$pages=Invoke-RestMethod 'http://127.0.0.1:9230/json/list' -TimeoutSec 3;'TARGETS='+@($pages).Count;foreach($p in @($pages)){if($p.type -eq 'page'){'PAGE='+$p.id+' '+$p.url}}}catch{'PAGES_ERROR='+$_}
