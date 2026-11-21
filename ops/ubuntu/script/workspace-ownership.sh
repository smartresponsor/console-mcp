#!/usr/bin/env bash
# ENG-16 narrow, fail-closed ACL transaction for the two approved targets.
set -euo pipefail
mode="${1:-audit}"
root=/home/alex/smartresponse
shared="$root/workspaces"
build="$root/mcp/console-mcp/dist"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
transaction="$script_dir/ownership-transaction.py"
journal_dir=/var/lib/console-mcp-ownership
journal="$journal_dir/transaction.json"

case "$mode" in
  audit|dry-run|apply|recover) ;;
  *) echo 'Usage: workspace-ownership.sh [audit|dry-run|apply|recover]' >&2; exit 2 ;;
esac

echo "mode=$mode root=$root"
for user in alex console-mcp; do id "$user" >/dev/null || exit 3; done
command -v getfacl >/dev/null || { echo 'Missing acl package (getfacl/setfacl)' >&2; exit 4; }
command -v setfacl >/dev/null || { echo 'Missing setfacl' >&2; exit 4; }
command -v python3 >/dev/null || { echo 'Missing python3' >&2; exit 4; }

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

# Read-only descriptor/inode traversal for audit and dry-run; no ACL mutation.
for dir in "$shared" "$build"; do
  if [[ -d "$dir" && ! -L "$dir" ]]; then
    python3 -B "$script_dir/ownership-preflight.py" "$dir"
  elif [[ -e "$dir" || -L "$dir" ]]; then
    echo "Unsafe target: $dir" >&2
    exit 6
  else
    echo "PREFLIGHT_ABSENT $dir"
  fi
done

if [[ "$mode" == audit ]]; then
  exit 0
fi
if [[ "$mode" == dry-run ]]; then
  echo "PLAN: metadata-only ACL transaction over exactly workspaces and generated dist"
  echo "PLAN: snapshot UID/GID/mode/access/default ACL; no source, .git, secrets or runtime mutations"
  echo "PLAN: no mutation performed; apply requires both targets to exist"
  exit 0
fi

[[ $EUID -eq 0 ]] || { echo 'Apply/recover requires root; no elevation attempted.' >&2; exit 77; }
[[ -d "$shared" && ! -L "$shared" ]] || { echo "Required target missing or unsafe: $shared" >&2; exit 78; }
[[ -d "$build" && ! -L "$build" ]] || { echo "Required target missing or unsafe: $build" >&2; exit 78; }

# The durable journal lives outside either target and is root-only.
# Do not chmod/chown an existing directory; reject unexpected ownership/mode.
if [[ ! -e "$journal_dir" && ! -L "$journal_dir" ]]; then
  mkdir -m 0700 -- "$journal_dir"
fi
[[ -d "$journal_dir" && ! -L "$journal_dir" ]] || { echo 'Unsafe journal directory' >&2; exit 78; }
read -r journal_uid journal_gid journal_mode < <(stat -c '%u %g %a' "$journal_dir")
[[ "$journal_uid" == 0 && "$journal_gid" == 0 && "$journal_mode" == 700 ]] || { echo 'Journal directory must be root:root mode 0700' >&2; exit 78; }

exec python3 -B "$transaction" "$mode" \
  --target "$shared" \
  --target "$build" \
  --journal "$journal"
