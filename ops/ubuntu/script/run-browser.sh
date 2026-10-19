#!/usr/bin/env bash
set -euo pipefail

: "${CONSOLE_MCP_BROWSER_BIN:=/usr/bin/microsoft-edge-stable}"
: "${CONSOLE_MCP_BROWSER_DEBUG_PORT:=9223}"
: "${CONSOLE_MCP_BROWSER_DISPLAY:=:99}"
: "${CONSOLE_MCP_BROWSER_URL:=https://chatgpt.com/}"

browser_mode="${CONSOLE_MCP_BROWSER_MODE:-isolated}"
case "${browser_mode}" in
  isolated|visible) ;;
  *) echo "Unsupported browser mode: ${browser_mode}" >&2; exit 1 ;;
esac

# Visible mode must not depend on Xvfb being installed.
required_commands=("${CONSOLE_MCP_BROWSER_BIN}")
if [[ "${browser_mode}" == "isolated" ]]; then required_commands+=(Xvfb); fi
for command in "${required_commands[@]}"; do
  command -v "${command}" >/dev/null || {
    echo "Required browser command is unavailable: ${command}" >&2
    exit 1
  }
done

# Opt-in interactive Edge instance: never touch the existing isolated :99 worker.
# This path runs as the logged-in desktop user and uses a separate profile/port.
if [[ "${CONSOLE_MCP_BROWSER_MODE:-isolated}" == "visible" ]]; then
  [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] || {
    echo "Visible Edge requires a desktop DISPLAY or WAYLAND_DISPLAY" >&2
    exit 1
  }
  [[ "${EUID}" != "0" && "$(id -un)" != "console-mcp" ]] || {
    echo "Visible Edge must run as the desktop user" >&2
    exit 1
  }
  # DISPLAY alone may point to a detached, remote or synthetic X server.
  [[ -n "${XDG_SESSION_ID:-}" ]] || {
    echo "Visible Edge requires an identified local logind session" >&2
    exit 1
  }
  session_properties="$(loginctl show-session "${XDG_SESSION_ID}" -p Active -p Remote -p Class -p Type -p Name -p LockedHint 2>/dev/null)" || {
    echo "Cannot inspect the desktop logind session" >&2
    exit 1
  }
  grep -qx "Active=yes" <<< "${session_properties}" &&
  grep -qx "Remote=no" <<< "${session_properties}" &&
  grep -qx "Class=user" <<< "${session_properties}" &&
  grep -qx "Name=$(id -un)" <<< "${session_properties}" &&
  grep -qx "LockedHint=no" <<< "${session_properties}" &&
  grep -Eq "^Type=(x11|wayland)$" <<< "${session_properties}" || {
    echo "Visible Edge requires an active, unlocked local graphical user session" >&2
    exit 1
  }
  exec "${CONSOLE_MCP_BROWSER_BIN}" \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="${CONSOLE_MCP_VISIBLE_EDGE_DEBUG_PORT:-9224}" \
    --user-data-dir="${HOME}/.config/console-mcp-edge-visible" \
    --no-first-run --no-default-browser-check \
    "${CONSOLE_MCP_BROWSER_URL}"
fi

state_dir="/var/lib/console-mcp-browser"
profile_dir="${state_dir}/edge-profile"
xauthority="${XDG_RUNTIME_DIR:-/run/console-mcp-browser}/Xauthority"
mkdir -p "${profile_dir}"
touch "${xauthority}"
chmod 0600 "${xauthority}"

# Configure the dedicated exchange root before Edge opens its profile. Updating
# only download.default_directory preserves browser sessions and authentication.
if [[ -n "${CONSOLE_MCP_BROWSER_DOWNLOAD_ROOT:-}" ]]; then
  if [[ "${CONSOLE_MCP_BROWSER_DOWNLOAD_ROOT}" != /* ]] || \
     [[ ! -d "${CONSOLE_MCP_BROWSER_DOWNLOAD_ROOT}" ]] || \
     [[ ! -w "${CONSOLE_MCP_BROWSER_DOWNLOAD_ROOT}" ]]; then
    echo "Browser download root must be an existing writable absolute directory" >&2
    exit 1
  fi
  python3 - "${profile_dir}" "${CONSOLE_MCP_BROWSER_DOWNLOAD_ROOT}" <<'PYTHON'
import json
import os
from pathlib import Path
import sys
import tempfile

preferences = Path(sys.argv[1]) / "Default" / "Preferences"
preferences.parent.mkdir(parents=True, exist_ok=True)
data = json.loads(preferences.read_text()) if preferences.exists() else {}
data.setdefault("download", {})["default_directory"] = str(Path(sys.argv[2]).resolve(strict=True))
fd, temporary = tempfile.mkstemp(prefix=".download-preferences-", dir=preferences.parent)
try:
    with os.fdopen(fd, "w") as stream:
        json.dump(data, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, preferences)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PYTHON
fi

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
