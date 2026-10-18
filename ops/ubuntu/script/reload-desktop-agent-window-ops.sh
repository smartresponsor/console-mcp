#!/bin/bash
set -euo pipefail
[[ "$EUID" == 0 ]] || { echo "admin authorization required" >&2; exit 77; }
root=/home/alex/smartresponse/mcp/console-mcp
agent="$root/ops/ubuntu/script/desktop-session-agent.py"
window="$root/ops/ubuntu/script/window-ops.py"
python3 -m py_compile "$agent" "$window"
userctl() { runuser -u alex -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user "$@"; }
userctl is-active --quiet console-mcp-desktop-agent.service
userctl restart console-mcp-desktop-agent.service
userctl is-active --quiet console-mcp-desktop-agent.service
echo "DESKTOP_AGENT_RELOADED; EDGE_UNCHANGED; CONSOLE_UNCHANGED"
