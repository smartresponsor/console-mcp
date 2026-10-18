#!/bin/bash
set -euo pipefail
[[ "$EUID" == 0 ]] || { echo "admin authorization required" >&2; exit 77; }
root=/home/alex/smartresponse/mcp/console-mcp
src="$root/tmp/desktop-focus-x11-window-id-fix-20261018/dist/service/visible-browser-session.js"
dst="$root/dist/service/visible-browser-session.js"
backup="$root/tmp/desktop-focus-x11-window-id-fix-20261018/visible-browser-session.before.js"
printf "%s  %s\n" "de0d6910d5c82274aa30eaab66c50fb9afaf6d0efbc34cccd2695aa3c51d1520" "$src" | sha256sum --check --quiet
[[ -f "$dst" && ! -e "$backup" ]] || { echo "Missing runtime or backup already exists" >&2; exit 1; }
cp -a "$dst" "$backup"
temp=$(mktemp "$root/dist/service/.visible-browser-session.XXXXXXXX")
trap 'rm -f "$temp"' EXIT
cp "$src" "$temp"
chmod --reference="$dst" "$temp"
chown --reference="$dst" "$temp"
mv -f "$temp" "$dst"
trap - EXIT
echo "X11_ACTIVE_WINDOW_PARSER_INSTALLED; EDGE_UNCHANGED; AGENT_UNCHANGED; CONSOLE_UNCHANGED"
