#!/bin/bash
set -euo pipefail
[[ "$EUID" == 0 ]] || { echo 'root authorization required' >&2; exit 77; }
root=/home/alex/smartresponse/mcp/console-mcp
source_file="$root/tmp/desktop-focus-20261018/dist/cli/desktop-focus-cli.js"
target="$root/dist/cli/desktop-focus-cli.js"
sha=20361101a66181890650396184b30d8bc6be97ddcfd69d6af78069313396d5b1
printf '%s  %s\n' "$sha" "$source_file" | sha256sum --check --quiet
[[ -d "$root/dist/cli" ]] || { echo 'installed CLI directory missing' >&2; exit 1; }
[[ ! -e "$target" ]] || { echo 'target already exists; preserve existing runtime' >&2; exit 1; }
[[ -r "$root/ops/ubuntu/script/native-window-activate.py" ]] || exit 1
[[ -r "$root/ops/ubuntu/script/desktop-session-agent.py" ]] || exit 1
install -m 0644 "$source_file" "$target"
rollback() { rm -f "$target"; runuser -u alex -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user restart console-mcp-desktop-agent.service || true; }
trap rollback ERR
runuser -u alex -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user restart console-mcp-desktop-agent.service
runuser -u alex -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user is-active --quiet console-mcp-desktop-agent.service
trap - ERR
echo 'DESKTOP_FOCUS_INSTALLED; EDGE_UNCHANGED; CONSOLE_UNCHANGED'
