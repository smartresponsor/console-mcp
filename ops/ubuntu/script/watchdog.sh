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
  log "restarting ${unit} after confirmed health failure"
  systemctl restart "${unit}"
}

if ! systemctl is-active --quiet console-mcp.service; then
  restart_unit console-mcp.service
elif ! probe_twice "${CONSOLE_MCP_WATCHDOG_MCP_URL}" mcp; then
  restart_unit console-mcp.service
else
  log "MCP health is ready"
fi

if ! systemctl is-active --quiet console-mcp-browser.service; then
  restart_unit console-mcp-browser.service
elif ! probe_twice "${CONSOLE_MCP_WATCHDOG_CDP_URL}" cdp; then
  restart_unit console-mcp-browser.service
else
  log "browser CDP health is ready"
fi
