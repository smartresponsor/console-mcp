#!/usr/bin/env bash
set -euo pipefail
# Separate persistent Edge profile per eBay store. Does not reuse or copy sessions.
usage() { echo "Usage: $0 --check|--launch toner|general" >&2; exit 64; }
[[ $# -eq 2 ]] || usage
mode="$1"; store="$2"
case "$mode" in --check|--launch) ;; *) usage ;; esac
case "$store" in toner) port=9226 ;; general) port=9227 ;; *) usage ;; esac
[[ "$(id -u)" -ne 0 ]] || { echo 'REFUSED_ROOT'; exit 77; }
profile="${HOME}/.config/console-mcp-ebay-${store}"
browser="${CONSOLE_MCP_EBAY_BROWSER_BIN:-/usr/bin/microsoft-edge-stable}"
[[ -x "$browser" ]] || { echo 'BROWSER_BINARY_MISSING'; exit 69; }
port_occupied() {
  # An already listening port must never be adopted or reused by another store.
  [[ -n "$(ss -H -ltn "sport = :$port" 2>/dev/null)" ]]
}
if port_occupied; then echo "STORE_BROWSER_PORT_OCCUPIED store=${store} port=${port}"; exit 73; fi
if [[ "$mode" == --check ]]; then
  echo "STORE_BROWSER_PREFLIGHT_ONLY user=$(id -un) store=${store} port=${port} profile=${profile}"
  exit 0
fi
[[ "$(id -un)" != "console-mcp" ]] || { echo 'DESKTOP_USER_REQUIRED'; exit 77; }
[[ -n "${DISPLAY:-}" ]] || { echo 'GUI_DISPLAY_REQUIRED'; exit 75; }
[[ -n "${XDG_SESSION_ID:-}" ]] || { echo 'GUI_SESSION_REQUIRED'; exit 75; }
properties="$(loginctl show-session "$XDG_SESSION_ID" -p Active -p Name -p LockedHint -p Class -p Type 2>/dev/null)" || {
  echo 'GUI_SESSION_UNVERIFIED'; exit 75;
}
grep -qx 'Active=yes' <<<"$properties" || { echo 'GUI_SESSION_INACTIVE'; exit 75; }
grep -qx 'LockedHint=no' <<<"$properties" || { echo 'GUI_SESSION_LOCKED'; exit 75; }
grep -qx 'Class=user' <<<"$properties" || { echo 'GUI_SESSION_INVALID'; exit 75; }
grep -qx "Name=$(id -un)" <<<"$properties" || { echo 'GUI_USER_MISMATCH'; exit 75; }
grep -Eq '^Type=(x11|wayland)$' <<<"$properties" || { echo 'GUI_TYPE_INVALID'; exit 75; }
if [[ -e "$profile" && ! -d "$profile" ]]; then echo 'STORE_PROFILE_INVALID'; exit 73; fi
mkdir -p -m 0700 "$profile"
chmod 0700 "$profile"
echo "STORE_BROWSER_LAUNCH store=${store} port=${port}"
exec "$browser" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$port" \
  --user-data-dir="$profile" --no-first-run --no-default-browser-check \
  https://www.ebay.com/
