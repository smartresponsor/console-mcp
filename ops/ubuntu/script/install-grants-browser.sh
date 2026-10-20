#!/usr/bin/env bash
# Standalone install: never restart, reload, or rebind Console MCP or existing Edge workers.
set -euo pipefail

unit_name="console-mcp-grants-browser.service"
unit_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/systemd/${unit_name}"
unit_target="/etc/systemd/system/${unit_name}"
service_user="console-mcp-grants"
state_dir="/var/lib/console-mcp-grants-browser"
port=9230

action="${1:---check}"
if [[ "$#" -ne 1 || ( "${action}" != "--check" && "${action}" != "--install" && "${action}" != "--status" ) ]]; then
  printf 'Usage: %s --check|--install|--status\n' "$0" >&2
  exit 2
fi

cdp_instance() {
  local port="$1"
  curl -fsS --max-time 3 "http://127.0.0.1:${port}/json/version" |
    python3 -c 'import sys,json,urllib.parse; d=json.load(sys.stdin); p=urllib.parse.urlsplit(d["webSocketDebuggerUrl"]); assert p.path.startswith("/devtools/browser/"); print(p.path)'
}

tcp_busy() {
  python3 - "$1" <<'PY'
import socket, sys
s = socket.socket()
s.settimeout(0.5)
try:
    busy = s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0
finally:
    s.close()
sys.exit(0 if busy else 1)
PY
}

require_baseline() {
  legacy_a="$(cdp_instance 9223)" || { echo "Missing legacy port 9223; stopping" >&2; exit 1; }
  legacy_b="$(cdp_instance 9224)" || { echo "Missing legacy port 9224; stopping" >&2; exit 1; }
  [[ "${legacy_a}" != "${legacy_b}" ]] || { echo "Legacy endpoints unexpectedly share a CDP instance" >&2; exit 1; }
  if tcp_busy "${port}"; then echo "Port ${port} already in use; stopping" >&2; exit 1; fi
}

if [[ "${action}" == "--status" ]]; then
  systemctl is-active "${unit_name}" || true
  if cdp_instance "${port}"; then echo "GRANTS_CDP_READY"; else echo "GRANTS_CDP_NOT_READY"; fi
  exit 0
fi

for cmd in curl python3 systemd-analyze; do command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 1; }; done
[[ -f "${unit_source}" && -x /usr/bin/microsoft-edge-stable ]] || { echo "Unit or Edge binary missing" >&2; exit 1; }
systemd-analyze verify "${unit_source}"
require_baseline
if [[ -e "${unit_target}" || -L "${unit_target}" ]]; then
  echo "Existing unit at ${unit_target} will not be overwritten" >&2
  exit 1
fi
if [[ "${action}" == "--check" ]]; then
  printf 'GRANTS_INSTALL_PREFLIGHT_OK (9230 free, legacy 9223/9224 healthy and distinct, new unit only)\n'
  exit 0
fi

[[ "${EUID}" -eq 0 ]] || { echo "Install requires root; no sudo prompting or privilege escalation is attempted" >&2; exit 1; }
for cmd in systemctl useradd id install ss awk; do command -v "$cmd" >/dev/null || exit 1; done
if ! id -u "${service_user}" >/dev/null 2>&1; then
  useradd --system --home-dir "${state_dir}" --no-create-home --shell /usr/sbin/nologin "${service_user}"
fi
install -d -m 0700 -o "${service_user}" -g "${service_user}" "${state_dir}"
install -m 0644 "${unit_source}" "${unit_target}"
installed=true
rollback() {
  if [[ "${installed}" == true ]]; then
    systemctl stop "${unit_name}" >/dev/null 2>&1 || true
    systemctl disable "${unit_name}" >/dev/null 2>&1 || true
    rm -f -- "${unit_target}"
    systemctl daemon-reload || true
    echo "GRANTS_UNIT_ROLLED_BACK (legacy workers untouched; dedicated state retained)" >&2
  fi
}
trap rollback EXIT
systemctl daemon-reload
systemctl start "${unit_name}"
ready=false
for i in $(seq 1 30); do
  if cdp_instance "${port}" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "${ready}" == true ]] || { echo "New Edge failed readiness" >&2; exit 1; }
new_instance="$(cdp_instance "${port}")"
[[ "${new_instance}" != "${legacy_a}" && "${new_instance}" != "${legacy_b}" ]] || {
  echo "New endpoint unexpectedly matches a legacy CDP instance" >&2
  exit 1
}
listener_addresses="$(ss -H -ltn "( sport = :9230 )" | awk '{print $4}')"
[[ -n "${listener_addresses}" ]] || { echo "No 9230 listener found" >&2; exit 1; }
while IFS= read -r bind; do
  if [[ "${bind}" != "127.0.0.1:9230" && "${bind}" != "[::1]:9230" ]]; then
    echo "Unsafe grant CDP bind address; rollback only new service" >&2
    exit 1
  fi
done <<< "${listener_addresses}"
[[ "$(cdp_instance 9223)" == "${legacy_a}" && "$(cdp_instance 9224)" == "${legacy_b}" ]] || {
  echo "Legacy browser instance changed during install; rollback only grants service" >&2
  exit 1
}
systemctl enable "${unit_name}"
installed=false
trap - EXIT
echo "GRANTS_BROWSER_SERVICE_ACTIVE (9230; independent user, profile, unit; no Console MCP routing)"
