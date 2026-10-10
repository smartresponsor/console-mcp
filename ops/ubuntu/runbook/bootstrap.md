# Ubuntu Bootstrap

This contour replaces the Windows Scheduled Task and interactive-session relay with systemd-managed services. It preserves the Windows recovery intent through a health watchdog without creating a second MCP server or schema catalog.

## Service Boundary

- console-mcp.service is the one MCP runtime. It serves OAuth on 127.0.0.1:3333 and Codex bearer on 127.0.0.1:3334.
- The service is owned by the unprivileged console-mcp account.
- Runtime state and sanitized transcripts belong under /var/lib/console-mcp. systemd bind-mounts `/var/lib/console-mcp/run` and `/var/lib/console-mcp/log` over `/home/alex/smartresponse/mcp/console-mcp/var/run` and `/home/alex/smartresponse/mcp/console-mcp/var/log`, so shared engine/capacity code keeps one path contract while the deployment remains read-only.
- Secrets belong only in /etc/console-mcp/console-mcp.env, owned by root:console-mcp with mode 0640.
- The repository deployment is read-only to the service after build.

## Bootstrap

1. Install Node.js 20+ and Git.
2. Use the existing checkout at /home/alex/smartresponse/mcp/console-mcp. The installer derives its deployment root from its location; `CONSOLE_MCP_ROOT` may select another existing checkout. Product repositories live under /home/alex/smartresponse.
3. Run npm ci, npm run typecheck, npm run build, and npm run smoke in /home/alex/smartresponse/mcp/console-mcp. The primary smoke test is implemented in Node.js and does not require PowerShell.
4. Run sudo /home/alex/smartresponse/mcp/console-mcp/ops/ubuntu/script/install-systemd.sh.
5. Edit /etc/console-mcp/console-mcp.env; preserve OAuth and bearer credentials and set `CONSOLE_MCP_WORKSPACE_ROOT=/home/alex/smartresponse`. The installer grants traversal-only ACLs through the private home directory to `console-mcp` and the capability-limited root watchdog. Component repositories still need explicit read/write access and per-repository Git trust for `console-mcp`. MCP infrastructure remains read-only to the service; runtime `run`, `log`, and `transcript` directories are writable bind mounts from `/var/lib/console-mcp`.
6. Run sudo /home/alex/smartresponse/mcp/console-mcp/ops/ubuntu/script/doctor.sh.
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
    sudo /home/alex/smartresponse/mcp/console-mcp/ops/ubuntu/script/doctor.sh

## Browser Boundary

console-mcp-browser.service is a separate, dependent worker. It owns one Microsoft Edge profile and private Xvfb display; Console MCP remains the only MCP runtime and browser task-state owner. The worker exposes CDP only on 127.0.0.1:9223 and adds no public endpoint.

Complete [the browser-worker runbook](browser-worker.md) before enabling it. The first ChatGPT login needs a controlled visual session; do not expose CDP or the virtual display directly to the network.

## Cloudflare Boundary

Keep the existing port authority: only the OAuth listener on 3333 may be tunnelled. The bearer listener on 3334 remains loopback-only. Install cloudflared separately and grant its service access only to http://127.0.0.1:3333.

## Browsing capability worker and Engine CLI

Console discovers sibling `browsing` and `looping` repositories without depending on cwd or name casing. The optional `browser-mcp-worker.service` serves semantic capabilities on loopback port 8791 and attaches to Console-owned Edge on 9223. It owns no browser lifecycle, task bank, or scheduling. Install `config/browsing.env.example` as `/etc/console-mcp/browsing.env`, set a generated worker token there and the same `BROWSER_MCP_BROWSER_WORKER_TOKEN` in `console-mcp.env`, then rerun the installer. Never change external attachment to managed-browser mode.

Use `sudo ./ops/ubuntu/script/engine-cli.sh status` for the persistent Engine task bank. The wrapper enters the running service's mount namespace so the CLI uses `/var/lib/console-mcp` state rather than a separate repository-local task bank. A controlled one-task run uses `go <component> --workspace=<verified-path> --native-engine --live --first-answer-only --ephemeral-target --prompt-file=<reviewed-file>`; do not invoke it during bootstrap.
