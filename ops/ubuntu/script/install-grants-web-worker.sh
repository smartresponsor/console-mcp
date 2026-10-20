#!/usr/bin/env bash
set -euo pipefail
base="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
unit="console-mcp-grants-web-worker.service"
source_unit="$base/ops/ubuntu/systemd/$unit"
dest_unit="/etc/systemd/system/$unit"
browser_unit="console-mcp-grants-browser.service"
cdp_instance() {
  curl -fsS --max-time 4 "http://127.0.0.1:$1/json/version" | python3 -c 'import json,sys; print(json.load(sys.stdin)["webSocketDebuggerUrl"].split("/devtools/browser/")[1])'
}
status() {
  systemctl show "$unit" --property=ActiveState --property=SubState --property=User --property=MainPID --no-pager
  if curl -fsS --max-time 3 'http://127.0.0.1:8797/healthz' >/dev/null; then echo "GRANTS_SEMANTIC_WORKER_HEALTHY"; else echo "GRANTS_SEMANTIC_WORKER_NOT_READY"; fi
}
check() {
  test -r "$source_unit" || { echo "Missing dedicated unit" >&2; return 1; }
  test -r /etc/console-mcp/browsing.env || { echo "Missing token-bearing browsing.env" >&2; return 1; }
  test -r "$base/dist/service/grants-browser-session.js" || { echo "Compile Console MCP grants module using npm run build before installation" >&2; return 1; }
  test -r /home/alex/smartresponse/mcp/looping/browsing/playwright-worker/src/worker.js || return 1
  node --check /home/alex/smartresponse/mcp/looping/browsing/playwright-worker/src/worker.js
  systemd-analyze verify "$source_unit" >/dev/null
  [[ "$(systemctl show "$browser_unit" --property=ActiveState --value)" == "active" ]] || { echo "Grants Edge not active" >&2; return 1; }
  for p in 9223 9224 9230; do cdp_instance "$p" >/dev/null; done
  node --experimental-strip-types "$base/tool/grants-routing-preflight.mjs" >/dev/null || { echo "Grants proof failed in actual host context" >&2; return 1; }
}
case "${1:-}" in
  --status) status; exit 0 ;;
  --check)
    if [[ -e "$dest_unit" ]]; then echo "Unit already installed; use --status" >&2; exit 1; fi
    if curl --silent --max-time 1 'http://127.0.0.1:8797/healthz' >/dev/null; then echo "Port 8797 is already allocated" >&2; exit 1; fi
    check
    echo "GRANTS_WEB_WORKER_PREFLIGHT_OK"; exit 0 ;;
  --install) ;;
  *) echo "Usage: $0 --check|--install|--status" >&2; exit 2 ;;
esac
[[ "${EUID}" -eq 0 ]] || { echo "--install requires root via sudo" >&2; exit 1; }
[[ ! -e "$dest_unit" ]] || { echo "Unit exists; refusing overwrite" >&2; exit 1; }
if curl --silent --max-time 1 'http://127.0.0.1:8797/healthz' >/dev/null; then echo "Port 8797 in use" >&2; exit 1; fi
check
legacy_a="$(cdp_instance 9223)"
legacy_b="$(cdp_instance 9224)"
grants_before="$(cdp_instance 9230)"
install -m 0644 "$source_unit" "$dest_unit"
rollback=1
clean() {
  if [[ "$rollback" == 1 ]]; then
    systemctl stop "$unit" >/dev/null 2>&1 || true
    systemctl disable "$unit" >/dev/null 2>&1 || true
    rm -f "$dest_unit"
    systemctl daemon-reload || true
    echo "GRANTS_WEB_WORKER_ROLLED_BACK (legacy services untouched)" >&2
  fi
}
trap clean EXIT
systemctl daemon-reload
systemctl start "$unit"
ready=0
for _ in $(seq 1 25); do
  if curl -fsS --max-time 2 'http://127.0.0.1:8797/healthz' >/dev/null; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo "Dedicated semantic worker did not start" >&2; exit 1; }
[[ "$(systemctl show "$unit" --property=ActiveState --value)" == active ]] || exit 1
[[ "$(systemctl show "$unit" --property=User --value)" == "console-mcp-grants" ]] || exit 1
[[ "$(cdp_instance 9223)" == "$legacy_a" && "$(cdp_instance 9224)" == "$legacy_b" && "$(cdp_instance 9230)" == "$grants_before" ]] || {
  echo "Existing or grants CDP browser instance changed during installation" >&2
  exit 1
}
systemctl enable "$unit"
rollback=0
echo "GRANTS_WEB_WORKER_ACTIVE (8797 -> 9230; existing sessions preserved; Console runtime restart still separate)"
