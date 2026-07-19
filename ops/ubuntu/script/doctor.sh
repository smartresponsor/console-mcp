#!/usr/bin/env bash
set -euo pipefail

failures=0

check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'OK   %s\n' "${label}"
  else
    printf 'FAIL %s\n' "${label}" >&2
    failures=1
  fi
}

check "systemd is available" systemctl --version
check "node is available" node --version
check "service unit is installed" test -f /etc/systemd/system/console-mcp.service
check "service environment is installed" test -f /etc/console-mcp/console-mcp.env
check "compiled runtime exists" test -f /opt/console-mcp/dist/index.js
check "console-mcp service is enabled" systemctl is-enabled --quiet console-mcp.service

if [[ -f /etc/console-mcp/console-mcp.env ]]; then
  grep -q '^CONSOLE_MCP_MANAGED_RUNTIME=systemd$' /etc/console-mcp/console-mcp.env || {
    printf 'FAIL managed runtime must be systemd\n' >&2
    failures=1
  }
  grep -q '^CONSOLE_MCP_BEARER_TOKEN=.' /etc/console-mcp/console-mcp.env || {
    printf 'FAIL Codex bearer token is not configured\n' >&2
    failures=1
  }
fi

if systemctl is-active --quiet console-mcp.service; then
  printf 'OK   console-mcp service is active\n'
else
  printf 'WARN console-mcp service is not active\n'
fi

exit "${failures}"
