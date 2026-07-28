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

for command in systemctl node install; do
  command -v "${command}" >/dev/null || {
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  }
done

id -u console-mcp >/dev/null 2>&1 || useradd --system --home-dir /var/lib/console-mcp --create-home --shell /usr/sbin/nologin console-mcp
install -d -o root -g console-mcp -m 0750 "${config_dir}"
install -o root -g root -m 0644 "${unit_source}" "${unit_target}"
install -o root -g root -m 0644 "${browser_unit_source}" "${browser_unit_target}"
install -o root -g root -m 0644 "${watchdog_unit_source}" "${watchdog_unit_target}"
install -o root -g root -m 0644 "${watchdog_timer_source}" "${watchdog_timer_target}"
install -o root -g root -m 0755 "${repository_root}/ops/ubuntu/script/watchdog.sh" /opt/console-mcp/ops/ubuntu/script/watchdog.sh

if [[ ! -f "${env_target}" ]]; then
  install -o root -g console-mcp -m 0640 "${env_example}" "${env_target}"
  echo "Created ${env_target}; fill the OAuth and bearer values before enabling the service." >&2
else
  echo "Preserved existing ${env_target}." >&2
fi

if [[ ! -f "${browser_env_target}" ]]; then
  install -o root -g console-mcp -m 0640 "${browser_env_example}" "${browser_env_target}"
  echo "Created ${browser_env_target}; configure the verified Chromium executable before starting the browser worker." >&2
else
  echo "Preserved existing ${browser_env_target}." >&2
fi

if [[ ! -d /opt/console-mcp/dist ]]; then
  echo "Missing /opt/console-mcp/dist. Deploy and build the repository before enabling the service." >&2
  exit 1
fi

systemctl daemon-reload
systemctl enable console-mcp.service
systemctl enable console-mcp-browser.service
systemctl enable console-mcp-watchdog.timer
systemctl reset-failed console-mcp.service
systemctl reset-failed console-mcp-browser.service console-mcp-watchdog.service || true
echo "Installed Console MCP, browser worker, and health watchdog units. Start them after configuration with systemctl start console-mcp.service console-mcp-browser.service console-mcp-watchdog.timer."
