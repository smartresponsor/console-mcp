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
3. Run npm ci and npm run build in /opt/console-mcp.
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

This milestone deliberately does not start Chromium. The service is prepared to be the stable control plane first. A later browser-worker unit will own a dedicated virtual display and browser profile; it will communicate with this same MCP runtime and will not add public endpoints.

## Cloudflare Boundary

Keep the existing port authority: only the OAuth listener on 3333 may be tunnelled. The bearer listener on 3334 remains loopback-only. Install cloudflared separately and grant its service access only to http://127.0.0.1:3333.
