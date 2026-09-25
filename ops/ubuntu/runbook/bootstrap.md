# Ubuntu Bootstrap

This contour replaces the Windows Scheduled Task and interactive-session relay with systemd-managed services. It preserves the Windows recovery intent through a health watchdog without creating a second MCP server or schema catalog.

## Service Boundary

- console-mcp.service is the one MCP runtime. It serves OAuth on 127.0.0.1:3333 and Codex bearer on 127.0.0.1:3334.
- The service is owned by the unprivileged console-mcp account.
- Runtime state and sanitized transcripts belong under /var/lib/console-mcp. systemd bind-mounts `/var/lib/console-mcp/run` and `/var/lib/console-mcp/log` over `/opt/console-mcp/var/run` and `/opt/console-mcp/var/log`, so shared engine/capacity code keeps one path contract while the deployment remains read-only.
- Secrets belong only in /etc/console-mcp/console-mcp.env, owned by root:console-mcp with mode 0640.
- The repository deployment is read-only to the service after build.

## Bootstrap

1. Install Node.js 20+ and Git.
2. Deploy this repository to /opt/console-mcp as root or a deployment account.
3. Run npm ci, npm run typecheck, npm run build, and npm run smoke in /opt/console-mcp. The primary smoke test is implemented in Node.js and does not require PowerShell.
4. Run sudo /opt/console-mcp/ops/ubuntu/script/install-systemd.sh.
5. Edit /etc/console-mcp/console-mcp.env; configure OAuth and the bearer token.
6. Run sudo /opt/console-mcp/ops/ubuntu/script/doctor.sh.
7. Start with sudo systemctl start console-mcp.service console-mcp-browser.service console-mcp-watchdog.timer.
8. Inspect with systemctl status console-mcp.service console-mcp-browser.service console-mcp-watchdog.timer.

## Runtime parity

Every watchdog timer pass now updates the same durable runtime-capacity snapshots used on Windows, including resource pressure, age-aware engine pressure, watchdog/broker freshness, stability and recovery state, and the append-only failure ledger. It also runs the shared browser-target reaper and plugin/settings cleanup against loopback CDP. Trace rotation, ChatGPT/heavy execution semaphores, ephemeral background targets, and between-round capacity checks stay in shared Node code and therefore use the same implementation on Ubuntu.

## SSH Operations

    sudo systemctl status console-mcp.service
    sudo systemctl restart console-mcp.service
    sudo systemctl restart console-mcp-browser.service
    sudo systemctl start console-mcp-watchdog.service
    sudo journalctl -u console-mcp.service -n 200 --no-pager
    sudo journalctl -u console-mcp-watchdog.service -n 200 --no-pager
    sudo /opt/console-mcp/ops/ubuntu/script/doctor.sh

## Browser Boundary

console-mcp-browser.service is a separate, dependent worker. It owns one Chromium profile and private Xvfb display; Console MCP remains the only MCP runtime and browser task-state owner. The worker exposes CDP only on 127.0.0.1:9223 and adds no public endpoint.

Complete [the browser-worker runbook](browser-worker.md) before enabling it. The first ChatGPT login needs a controlled visual session; do not expose CDP or the virtual display directly to the network.

## Cloudflare Boundary

Keep the existing port authority: only the OAuth listener on 3333 may be tunnelled. The bearer listener on 3334 remains loopback-only. Install cloudflared separately and grant its service access only to http://127.0.0.1:3333.
