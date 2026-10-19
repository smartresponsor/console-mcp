#!/bin/bash
set -euo pipefail
[[ "$EUID" == 0 ]] || { echo "admin authorization required" >&2; exit 77; }
root=/home/alex/smartresponse/mcp/console-mcp
src="$root/tmp/desktop-focus-diagnostics-20261018/dist/service/visible-browser-session.js"
dst="$root/dist/service/visible-browser-session.js"
backup="$root/tmp/desktop-focus-diagnostics-20261018/visible-browser-session.before.js"
printf "%s  %s\n" "17e34508e88dde0c097efce8ef4a2e0aecc2ca1e56c61aa3647883f5de91c80d" "$src" | sha256sum --check --quiet
[[ -f "$dst" && ! -e "$backup" ]] || { echo "Existing backup or missing runtime; abort" >&2; exit 1; }
cp -a "$dst" "$backup"
temp=$(mktemp "$root/dist/service/.visible-browser-session.XXXXXXXX")
trap 'rm -f "$temp"' EXIT
cp "$src" "$temp"
chmod --reference="$dst" "$temp"
chown --reference="$dst" "$temp"
mv -f "$temp" "$dst"
trap - EXIT
echo "X11_DIAGNOSTICS_INSTALLED; EDGE_UNCHANGED; AGENT_UNCHANGED; CONSOLE_UNCHANGED"
