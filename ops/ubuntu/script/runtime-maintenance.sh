#!/usr/bin/env bash
set -euo pipefail

: "${CONSOLE_MCP_ROOT:=/opt/console-mcp}"
: "${CONSOLE_MCP_BROWSER_DEBUG_PORT:=9223}"
: "${CONSOLE_MCP_MAINTENANCE_TIMEOUT_MS:=3000}"
: "${CONSOLE_MCP_MAINTENANCE_MAX_CLOSE:=10}"

mcp_ok="${1:-true}"
cdp_ok="${2:-true}"
watchdog_pid="${3:-$$}"

run_as_console_mcp() {
  if command -v runuser >/dev/null 2>&1 && id -u console-mcp >/dev/null 2>&1; then
    runuser -u console-mcp -- "$@"
  else
    "$@"
  fi
}

run_as_console_mcp node --enable-source-maps "${CONSOLE_MCP_ROOT}/dist/cli/ubuntu-runtime-maintenance-cli.js" \
  "--root=${CONSOLE_MCP_ROOT}" \
  "--mcp-ok=${mcp_ok}" \
  "--cdp-ok=${cdp_ok}" \
  "--watchdog-pid=${watchdog_pid}"

if [[ "${cdp_ok}" == "true" ]]; then
  run_as_console_mcp node --enable-source-maps "${CONSOLE_MCP_ROOT}/dist/cli/engine-browser-target-reaper-cli.js" \
    "--root=${CONSOLE_MCP_ROOT}" \
    "--ports=${CONSOLE_MCP_BROWSER_DEBUG_PORT}" \
    "--max-close=${CONSOLE_MCP_MAINTENANCE_MAX_CLOSE}" \
    "--timeout-ms=${CONSOLE_MCP_MAINTENANCE_TIMEOUT_MS}" || true

  run_as_console_mcp node --enable-source-maps "${CONSOLE_MCP_ROOT}/dist/cli/chatgpt-browser-session-cli.js" \
    plugin-settings-cleanup \
    "--ports=${CONSOLE_MCP_BROWSER_DEBUG_PORT}" \
    "--max-close=${CONSOLE_MCP_MAINTENANCE_MAX_CLOSE}" \
    "--timeout-ms=${CONSOLE_MCP_MAINTENANCE_TIMEOUT_MS}" \
    --confirm-cleanup || true
fi
