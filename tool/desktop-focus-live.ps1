param([ValidatePattern('^[0-9A-Fa-f]{32}$')][string]$TargetId = 'E33118268E63396AE683D23D149CF9B5')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$request = @{version=1;requestId=[guid]::NewGuid().ToString();operation='focus';targetId=$TargetId} | ConvertTo-Json -Compress
$request | & /usr/bin/python3 (Join-Path $root 'ops/ubuntu/script/desktop-agent-client.py')
if ($LASTEXITCODE -ne 0) { throw 'Desktop focus IPC failed' }
