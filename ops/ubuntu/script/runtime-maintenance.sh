#!/usr/bin/env bash
set -euo pipefail

: "${CONSOLE_MCP_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
: "${CONSOLE_MCP_BROWSER_DEBUG_PORT:=9223}"
: "${CONSOLE_MCP_MAINTENANCE_TIMEOUT_MS:=3000}"
: "${CONSOLE_MCP_MAINTENANCE_MAX_CLOSE:=10}"

if [[ -e /run/console-mcp-browser-leases ]]; then
  export CONSOLE_MCP_VISIBLE_OS_LEASES=required
  export CONSOLE_MCP_VISIBLE_LEASE_ROOT=/run/console-mcp-browser-leases
fi

mcp_ok="${1:-true}"
cdp_ok="${2:-true}"
watchdog_pid="${3:-$$}"

run_as_console_mcp() {
  if command -v runuser >/dev/null 2>&1 && id -u console-mcp >/dev/null 2>&1; then
    runuser -u console-mcp -- "$@"
  elif [[ "${CONSOLE_MCP_VISIBLE_OS_LEASES:-}" == "required" || -e /run/console-mcp-browser-leases ]]; then
    echo "Shared browser lease requires console-mcp identity; refusing fallback." >&2
    return 1
  else
    "$@"
  fi
}

run_as_console_mcp node --enable-source-maps "${CONSOLE_MCP_ROOT}/dist/cli/ubuntu-runtime-maintenance-cli.js" \
  "--root=${CONSOLE_MCP_ROOT}" \
  "--mcp-ok=${mcp_ok}" \
  "--cdp-ok=${cdp_ok}" \
  "--watchdog-pid=${watchdog_pid}" \
  "--mcp-state=${4:-UNKNOWN}" \
  "--cdp-state=${5:-UNKNOWN}"

if [[ "${cdp_ok}" == "true" && "${CONSOLE_MCP_WATCHDOG_ALLOW_BROWSER_CLEANUP:-false}" == "true" ]]; then
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
