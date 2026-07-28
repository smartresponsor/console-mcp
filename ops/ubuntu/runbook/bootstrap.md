# Ubuntu Bootstrap

This contour replaces the Windows Scheduled Task and interactive-session relay with a system service. It does not create a second MCP server or a second schema catalog.

## Service Boundary

- console-mcp.service is the one MCP runtime. It serves OAuth on 127.0.0.1:3333 and Codex bearer on 127.0.0.1:3334.
- The service is owned by the unprivileged console-mcp account.
- Runtime state and sanitized transcripts belong under /var/lib/console-mcp.
- Secrets belong only in /etc/console-mcp/console-mcp.env, owned by root:console-mcp with mode 0640.
- The repository deployment is read-only to the service after build.

## Bootstrap

1. Install Node.js 20+ and Git.
2. Deploy this repository to /opt/console-mcp as root or a deployment account.
3. Run npm ci, npm run typecheck, npm run build, and npm run smoke in /opt/console-mcp. The primary smoke test is implemented in Node.js and does not require PowerShell.
4. Run sudo /opt/console-mcp/ops/ubuntu/script/install-systemd.sh.
5. Edit /etc/console-mcp/console-mcp.env; configure OAuth and the bearer token.
6. Run sudo /opt/console-mcp/ops/ubuntu/script/doctor.sh.
7. Start with sudo systemctl start console-mcp.service.
8. Inspect with systemctl status console-mcp.service and journalctl -u console-mcp.service -f.

## SSH Operations

    sudo systemctl status console-mcp.service
    sudo systemctl restart console-mcp.service
    sudo journalctl -u console-mcp.service -n 200 --no-pager
    sudo /opt/console-mcp/ops/ubuntu/script/doctor.sh

## Browser Boundary

console-mcp-browser.service is a separate, dependent worker. It owns one Chromium profile and private Xvfb display; Console MCP remains the only MCP runtime and browser task-state owner. The worker exposes CDP only on 127.0.0.1:9223 and adds no public endpoint.

Complete [the browser-worker runbook](browser-worker.md) before enabling it. The first ChatGPT login needs a controlled visual session; do not expose CDP or the virtual display directly to the network.

## Cloudflare Boundary

Keep the existing port authority: only the OAuth listener on 3333 may be tunnelled. The bearer listener on 3334 remains loopback-only. Install cloudflared separately and grant its service access only to http://127.0.0.1:3333.
