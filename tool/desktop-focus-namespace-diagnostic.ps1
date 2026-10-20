$ErrorActionPreference='Continue'
Write-Output 'HOST_PROCESS_NAMESPACE'
& /usr/bin/cat /proc/self/status | Select-String 'NSpid|NStgid'
Write-Output 'AGENT_SOCKET'
& /usr/bin/ls -l /run/console-mcp-desktop/agent.sock
Write-Output 'GNOME_PID'
& /usr/bin/pgrep -af 'gnome-shell|mutter'
Write-Output 'X11_SESSION'
& /usr/bin/loginctl list-sessions --no-legend
Write-Output 'X11_ROOT'
& /usr/bin/printenv DISPLAY XAUTHORITY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
