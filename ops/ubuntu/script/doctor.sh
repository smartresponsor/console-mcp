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

warn() {
  printf 'WARN %s\n' "$1"
}

check "systemd is available" systemctl --version
check "node is available" node --version
check "MCP service unit is installed" test -f /etc/systemd/system/console-mcp.service
check "browser worker unit is installed" test -f /etc/systemd/system/console-mcp-browser.service
check "MCP service environment is installed" test -f /etc/console-mcp/console-mcp.env
check "browser worker environment is installed" test -f /etc/console-mcp/browser.env
check "compiled MCP runtime exists" test -f /opt/console-mcp/dist/index.js
check "MCP service is enabled" systemctl is-enabled --quiet console-mcp.service

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

if [[ -f /etc/console-mcp/browser.env ]]; then
  grep -q '^CONSOLE_MCP_BROWSER_BIN=/' /etc/console-mcp/browser.env || {
    printf 'FAIL browser executable must be an absolute path\n' >&2
    failures=1
  }
fi

if systemctl is-active --quiet console-mcp.service; then
  printf 'OK   MCP service is active\n'
else
  warn "MCP service is not active"
fi

if systemctl is-active --quiet console-mcp-browser.service; then
  printf 'OK   browser worker is active\n'
  if command -v curl >/dev/null 2>&1 && curl --fail --silent --max-time 3 http://127.0.0.1:9223/json/version >/dev/null; then
    printf 'OK   browser CDP is reachable only through loopback\n'
  else
    printf 'FAIL browser worker is active but CDP is unavailable on 127.0.0.1:9223\n' >&2
    failures=1
  fi
else
  warn "browser worker is not active; enable it after controlled visual login preparation"
fi

exit "${failures}"
