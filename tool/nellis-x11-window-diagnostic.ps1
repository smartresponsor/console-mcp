$ErrorActionPreference='Stop'
$env:DISPLAY=':0'
$env:XAUTHORITY='/run/user/1000/gdm/Xauthority'
$root = & xprop -root _NET_CLIENT_LIST _NET_CURRENT_DESKTOP _NET_ACTIVE_WINDOW 2>&1
$code = $LASTEXITCODE
if ($code -ne 0) { [pscustomobject]@{ok=$false;error=($root -join ' ').Substring(0,[math]::Min(300,($root -join ' ').Length))} | ConvertTo-Json -Compress; exit 0 }
$active = (($root | Select-String '_NET_ACTIVE_WINDOW').ToString() -split '\s+')[-1]
$desktop = (($root | Select-String '_NET_CURRENT_DESKTOP').ToString() -split '\s+')[-1]
$props = if ($active -match '^0x[0-9a-f]+$') { & xprop -id $active _NET_WM_PID WM_CLASS _NET_WM_DESKTOP _NET_WM_STATE 2>&1 } else { @() }
[pscustomobject]@{ok=$true;active=$active;desktop=$desktop;windowCount=([regex]::Matches(($root -join ' '),'0x[0-9a-f]+')).Count;props=@($props)} | ConvertTo-Json -Depth 4 -Compress
