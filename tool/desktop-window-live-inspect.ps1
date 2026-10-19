$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
foreach ($op in @('window-inspect-focus','window-inventory')) {
  $request=@{version=1;requestId=[guid]::NewGuid().ToString();operation=$op}|ConvertTo-Json -Compress
  $request | & /usr/bin/python3 (Join-Path $root 'ops/ubuntu/script/desktop-agent-client.py')
  if ($LASTEXITCODE -ne 0) { throw 'Desktop IPC failed' }
}
