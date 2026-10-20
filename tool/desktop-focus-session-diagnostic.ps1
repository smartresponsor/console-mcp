$ErrorActionPreference='Continue'
& /usr/bin/loginctl list-sessions --no-legend
& /usr/bin/pgrep -af 'gnome-shell|mutter'
& /usr/bin/which gdbus
& /usr/bin/which xdotool
& /usr/bin/which wmctrl
& /usr/bin/which xinput
& /usr/bin/which xprop
& /usr/bin/which xwininfo
& /usr/bin/pgrep -af 'gnome-shell|mutter|Xorg|Xwayland|anydesk'
