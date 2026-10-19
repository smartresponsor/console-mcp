#!/usr/bin/env bash
set -euo pipefail
(( EUID == 0 )) || { echo 'Root authorization required' >&2; exit 77; }
root=/home/alex/smartresponse/mcp/console-mcp
stage="$root/tmp/visible-runtime-import-20261016"
[[ -f "$stage/import-dist.sha256" && -f "$stage/dist/tool/web-artifact-import.js" ]] || { echo 'Reviewed candidate missing' >&2; exit 1; }
cd "$stage"
sha256sum -c --quiet import-dist.sha256
[[ -d "$root/dist" ]] || { echo 'Active dist missing' >&2; exit 1; }
old="$root/tmp/console-import-dist-before-20261016"
[[ ! -e "$old" ]] || { echo 'Dedicated rollback already exists; refusing overwrite' >&2; exit 1; }
# Both directories are on the same filesystem. Exchange them without a missing-dist window.
exchange() {
  python3 - "$root/dist" "$stage/dist" <<'PY'
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.renameat2(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 2):
    raise OSError(ctypes.get_errno(), "Atomic dist exchange failed")
PY
}
exchange
if ! systemctl restart console-mcp.service || ! systemctl is-active --quiet console-mcp.service; then
  echo 'Console restart failed, rolling back compiled dist' >&2
  exchange
  systemctl restart console-mcp.service || true
  exit 1
fi
mv "$stage/dist" "$old"
echo "IMPORT_RUNTIME_DEPLOYED; rollback preserved at $old"
echo 'Visible and isolated browser services were not restarted.'
