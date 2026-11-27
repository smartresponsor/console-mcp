#!/usr/bin/env bash
set -euo pipefail
# One CLI invocation in the service's existing persistent state mounts, not a worker daemon.
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
workspace_root="${CONSOLE_MCP_WORKSPACE_ROOT:-$(cd "${repository_root}/../.." && pwd)}"
if [[ "${EUID}" -ne 0 ]]; then
  echo "Use sudo $0 to access the Console service's state namespace." >&2
  exit 1
fi
pid="$(systemctl show console-mcp.service --property=MainPID --value)"
if [[ ! "${pid}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Console MCP service must be running." >&2
  exit 1
fi
lease_env=()
if [[ -e /run/console-mcp-browser-leases ]]; then
  lease_env=(CONSOLE_MCP_VISIBLE_OS_LEASES=required CONSOLE_MCP_VISIBLE_LEASE_ROOT=/run/console-mcp-browser-leases)
fi
exec nsenter --target "${pid}" --mount -- runuser -u console-mcp -- \
  env CONSOLE_MCP_WORKSPACE_ROOT="${workspace_root}" CONSOLE_MCP_MANAGED_RUNTIME=systemd "${lease_env[@]}" \
  /usr/bin/node --enable-source-maps "${repository_root}/dist/engine/engine-cli.js" "$@"
