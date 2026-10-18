#!/usr/bin/env bash
# SmartResponsor workspace write policy. Run in audit mode first; apply requires root.
set -euo pipefail
mode="${1:-audit}"
root=/home/alex/smartresponse
shared="$root/workspaces"
build="$root/mcp/console-mcp/dist"
case "$mode" in audit|apply) ;; *) echo 'Usage: workspace-ownership.sh [audit|apply]' >&2; exit 2;; esac
echo "mode=$mode root=$root"
for user in alex console-mcp; do id "$user" || exit 3; done
command -v getfacl >/dev/null || { echo 'Missing acl package (getfacl/setfacl)' >&2; exit 4; }
command -v setfacl >/dev/null || { echo 'Missing setfacl' >&2; exit 4; }
for dir in "$root" "$root/mcp" "$root/mcp/console-mcp"; do
  [[ -d "$dir" && ! -L "$dir" ]] || { echo "Invalid directory: $dir" >&2; exit 5; }
  stat -c '%U:%G %a %n' "$dir"
done
for dir in "$build" "$shared"; do
  if [[ -e "$dir" ]]; then
    [[ -d "$dir" && ! -L "$dir" ]] || { echo "Unsafe path: $dir" >&2; exit 6; }
    stat -c '%U:%G %a %n' "$dir"
    getfacl -cp "$dir"
  else
    echo "ABSENT $dir"
  fi
done
if [[ "$mode" == audit ]]; then exit 0; fi
[[ $EUID -eq 0 ]] || { echo 'Apply requires root; no elevation attempted.' >&2; exit 77; }
# Apply only to designated shared root and generated dist. Never traverse source, .git, secrets or profiles.
install -d -o alex -g smartresponse -m 2770 "$shared"
chmod g+s "$shared"
setfacl -m u:alex:rwx,u:console-mcp:rwx,g:smartresponse:rwx,m:rwx "$shared"
setfacl -m d:u:alex:rwx,d:u:console-mcp:rwx,d:g:smartresponse:rwx,d:m:rwx "$shared"
if [[ -d "$build" ]]; then
  # Restrict repair to build artifacts; do not chown any source tree.
  find "$build" -xdev -type l -print -quit | grep -q . && { echo 'Symlinks in dist: review required.' >&2; exit 7; }
  setfacl -R -m u:alex:rwX,u:console-mcp:rwX,m:rwX "$build"
  find "$build" -xdev -type d -exec setfacl -m d:u:alex:rwx,d:u:console-mcp:rwx,d:m:rwx {} +
fi
echo 'Policy applied to designated workspaces and Console build outputs only.'
