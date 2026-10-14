#!/usr/bin/env bash
set -euo pipefail

: "${CONSOLE_MCP_WATCHDOG_MCP_URL:=http://127.0.0.1:3334/mcp}"
: "${CONSOLE_MCP_WATCHDOG_CDP_URL:=http://127.0.0.1:9223/json/version}"
: "${CONSOLE_MCP_WATCHDOG_TIMEOUT_SECONDS:=5}"
: "${CONSOLE_MCP_WATCHDOG_RETRY_DELAY_SECONDS:=3}"

log() {
  printf 'console-mcp-watchdog: %s\n' "$*"
}

probe() {
  local url="$1"
  local mode="$2"
  local status

  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time "${CONSOLE_MCP_WATCHDOG_TIMEOUT_SECONDS}" "${url}" || true)"
  if [[ "${mode}" == "mcp" ]]; then
    [[ "${status}" == "200" || "${status}" == "400" || "${status}" == "401" || "${status}" == "405" ]]
    return
  fi

  [[ "${status}" == "200" ]]
}

probe_twice() {
  local url="$1"
  local mode="$2"
  probe "${url}" "${mode}" && return 0
  sleep "${CONSOLE_MCP_WATCHDOG_RETRY_DELAY_SECONDS}"
  probe "${url}" "${mode}"
}

restart_unit() {
  local unit="$1"
  # Recovery is explicitly opted into; monitoring must never override a manual stop.
  if [[ "${CONSOLE_MCP_WATCHDOG_ALLOW_RESTARTS:-false}" != "true" ]]; then
    log "observed unhealthy ${unit}; restart suppressed (observe-only)"
    return 0
  fi
  log "restarting ${unit} after confirmed health failure (recovery explicitly enabled)"
  systemctl restart "${unit}"
}

observe_unit() {
  local unit="$1" url="$2" mode="$3" active result state
  active="$(systemctl show "$unit" --property=ActiveState --value)"
  result="$(systemctl show "$unit" --property=Result --value)"
  case "$active" in
    inactive) state=ADMINISTRATIVELY_PAUSED ;;
    failed) state=CRASHED ;;
    active)
      if probe_twice "$url" "$mode"; then state=HEALTHY; else state=DEGRADED; fi ;;
    *) state=DEGRADED ;;
  esac
  log "$unit state=$state result=$result" >&2
  # Never recover an inactive/failed unit: only an already-active degraded service.
  if [[ "$active" == "active" && "$state" == "DEGRADED" ]]; then
    restart_unit "$unit" >&2
  fi
  printf '%s' "$state"
}

mcp_state="$(observe_unit console-mcp.service "${CONSOLE_MCP_WATCHDOG_MCP_URL}" mcp)"
cdp_state="$(observe_unit console-mcp-browser.service "${CONSOLE_MCP_WATCHDOG_CDP_URL}" cdp)"

mcp_ok=false
cdp_ok=false
if [[ "${mcp_state}" == "HEALTHY" ]] && probe "${CONSOLE_MCP_WATCHDOG_MCP_URL}" mcp; then mcp_ok=true; fi
if [[ "${cdp_state}" == "HEALTHY" ]] && probe "${CONSOLE_MCP_WATCHDOG_CDP_URL}" cdp; then cdp_ok=true; fi
"$(dirname "${BASH_SOURCE[0]}")/runtime-maintenance.sh" "${mcp_ok}" "${cdp_ok}" "$$" "${mcp_state}" "${cdp_state}"
