$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$req=@{version=1;requestId=[guid]::NewGuid().ToString();operation='window-inspect-focus'}|ConvertTo-Json -Compress
$req | & /usr/bin/python3 (Join-Path $root 'ops/ubuntu/script/desktop-agent-client.py')
if ($LASTEXITCODE -ne 0) { throw 'Desktop IPC failed' }
foreach ($name in @('gnome-shell','mutter')) {
  & /usr/bin/pgrep -a $name
}
& /usr/bin/loginctl list-sessions --no-legend
& /usr/bin/loginctl list-users --no-legend
