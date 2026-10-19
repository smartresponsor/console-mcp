#!/bin/bash
set -euo pipefail
[[ "$EUID" == 0 ]] || { echo "admin authorization required" >&2; exit 77; }
root=/home/alex/smartresponse/mcp/console-mcp
src="$root/tmp/desktop-focus-x11-proof-20261018/dist/service/visible-browser-session.js"
dst="$root/dist/service/visible-browser-session.js"
backup="$root/tmp/desktop-focus-x11-proof-20261018/visible-browser-session.before.js"
printf "%s  %s\n" "de4e741d57077387e67d6e58830e895e90c5000d8209aa453b19227038ab7a61" "$src" | sha256sum --check --quiet
[[ -f "$dst" && ! -e "$backup" ]] || { echo "Missing runtime or backup exists" >&2; exit 1; }
cp -a "$dst" "$backup"
temp=$(mktemp "$root/dist/service/.visible-browser-session.XXXXXXXX")
trap 'rm -f "$temp"' EXIT
cp "$src" "$temp"
chmod --reference="$dst" "$temp"
chown --reference="$dst" "$temp"
mv -f "$temp" "$dst"
trap - EXIT
echo "X11_FOCUS_PROOF_INSTALLED; EDGE_UNCHANGED; AGENT_UNCHANGED; CONSOLE_UNCHANGED"
