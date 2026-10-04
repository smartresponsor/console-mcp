#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
unit_source="${repository_root}/ops/ubuntu/systemd/console-mcp.service"
browser_unit_source="${repository_root}/ops/ubuntu/systemd/console-mcp-browser.service"
watchdog_unit_source="${repository_root}/ops/ubuntu/systemd/console-mcp-watchdog.service"
watchdog_timer_source="${repository_root}/ops/ubuntu/systemd/console-mcp-watchdog.timer"
env_example="${repository_root}/ops/ubuntu/config/console-mcp.env.example"
browser_env_example="${repository_root}/ops/ubuntu/config/console-mcp-browser.env.example"
unit_target="/etc/systemd/system/console-mcp.service"
browser_unit_target="/etc/systemd/system/console-mcp-browser.service"
watchdog_unit_target="/etc/systemd/system/console-mcp-watchdog.service"
watchdog_timer_target="/etc/systemd/system/console-mcp-watchdog.timer"
config_dir="/etc/console-mcp"
env_target="${config_dir}/console-mcp.env"
browser_env_target="${config_dir}/browser.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

deployment_root="${CONSOLE_MCP_ROOT:-${repository_root}}"
workspace_root="${CONSOLE_MCP_WORKSPACE_ROOT:-$(cd "${deployment_root}/../.." && pwd)}"
if [[ ! -f "${deployment_root}/dist/index.js" ]]; then
  echo "Missing compiled runtime under ${deployment_root}; build before installing units." >&2
  exit 1
fi

for command in systemctl node install python3; do
  command -v "${command}" >/dev/null || {
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  }
done

id -u console-mcp >/dev/null 2>&1 || useradd --system --home-dir /var/lib/console-mcp --create-home --shell /usr/sbin/nologin console-mcp
if [[ "${deployment_root}" == /home/* ]]; then
  command -v setfacl >/dev/null || { echo "Install acl for service traversal of the private home directory." >&2; exit 1; }
  relative_home="${deployment_root#/home/}"
  home_dir="/home/${relative_home%%/*}"
  # The unprivileged runtime and capability-limited root watchdog need traversal only.
  setfacl -m u:console-mcp:--x,u:root:--x "${home_dir}"
fi
runuser -u console-mcp -- test -r "${deployment_root}/dist/index.js"
install -d -o root -g console-mcp -m 0750 "${config_dir}"
render_unit() {
  python3 - "$1" "$2" "${deployment_root}" "${workspace_root}" <<'UNIT_PY'
import sys
from pathlib import Path
source, target, root, workspace = sys.argv[1:]
import re
parent = Path(root).parent
browsing = next((p for p in parent.iterdir() if p.name.lower() == 'browsing' and p.is_dir()), parent / 'browsing')
replacements = {
 '/home/alex/smartresponse/mcp/console-mcp': root,
 '/home/alex/smartresponse/mcp/browsing': str(browsing),
 '/home/alex/smartresponse/mcp': str(parent),
 '/home/alex/smartresponse': workspace,
}
pattern = '|'.join(re.escape(k) for k in replacements)
text = re.sub(pattern, lambda match: replacements[match.group()], Path(source).read_text())
Path(target).write_text(text)
Path(target).chmod(0o644)
UNIT_PY
}
render_unit "${unit_source}" "${unit_target}"
render_unit "${browser_unit_source}" "${browser_unit_target}"
render_unit "${watchdog_unit_source}" "${watchdog_unit_target}"
render_unit "${watchdog_timer_source}" "${watchdog_timer_target}"
if [[ -f "${config_dir}/browsing.env" ]]; then
  render_unit "${repository_root}/ops/ubuntu/systemd/browser-mcp-worker.service" /etc/systemd/system/browser-mcp-worker.service
  systemctl enable browser-mcp-worker.service
fi
chmod 0755 "${repository_root}"/ops/ubuntu/script/*.sh
install -d -o console-mcp -g console-mcp -m 0750 /var/lib/console-mcp/run /var/lib/console-mcp/log /var/lib/console-mcp/transcript
mkdir -p "${deployment_root}/var/run" "${deployment_root}/var/log" "${deployment_root}/var/transcript"

if [[ ! -f "${env_target}" ]]; then
  install -o root -g console-mcp -m 0640 "${env_example}" "${env_target}"
  echo "Created ${env_target}; fill the OAuth and bearer values before enabling the service." >&2
else
  echo "Preserved existing ${env_target}." >&2
fi

if [[ ! -f "${browser_env_target}" ]]; then
  install -o root -g console-mcp -m 0640 "${browser_env_example}" "${browser_env_target}"
  echo "Created ${browser_env_target}; configure the verified Edge executable before starting the browser worker." >&2
else
  echo "Preserved existing ${browser_env_target}." >&2
fi

systemctl daemon-reload
systemctl enable console-mcp.service
systemctl enable console-mcp-browser.service
systemctl enable console-mcp-watchdog.timer
systemctl reset-failed console-mcp.service
systemctl reset-failed console-mcp-browser.service console-mcp-watchdog.service || true
echo "Installed Console MCP, browser worker, and health watchdog units. Start them after configuration with systemctl start console-mcp.service console-mcp-browser.service console-mcp-watchdog.timer."
