#!/usr/bin/env bash
set -euo pipefail

: "${CONSOLE_MCP_BROWSER_BIN:?CONSOLE_MCP_BROWSER_BIN must be configured}"
: "${CONSOLE_MCP_BROWSER_DEBUG_PORT:=9223}"
: "${CONSOLE_MCP_BROWSER_DISPLAY:=:99}"
: "${CONSOLE_MCP_BROWSER_URL:=https://chatgpt.com/}"

for command in Xvfb "${CONSOLE_MCP_BROWSER_BIN}"; do
  command -v "${command}" >/dev/null || {
    echo "Required browser command is unavailable: ${command}" >&2
    exit 1
  }
done

state_dir="/var/lib/console-mcp-browser"
profile_dir="${state_dir}/profile"
xauthority="${XDG_RUNTIME_DIR:-/run/console-mcp-browser}/Xauthority"
mkdir -p "${profile_dir}"
touch "${xauthority}"
chmod 0600 "${xauthority}"

export DISPLAY="${CONSOLE_MCP_BROWSER_DISPLAY}"
export XAUTHORITY="${xauthority}"

Xvfb "${DISPLAY}" -screen 0 1440x1024x24 -nolisten tcp -auth "${XAUTHORITY}" &
xvfb_pid="$!"

cleanup() {
  kill "${xvfb_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

"${CONSOLE_MCP_BROWSER_BIN}" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="${CONSOLE_MCP_BROWSER_DEBUG_PORT}" \
  --user-data-dir="${profile_dir}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  "${CONSOLE_MCP_BROWSER_URL}" &
browser_pid="$!"

wait "${browser_pid}"
