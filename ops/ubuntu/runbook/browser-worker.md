# Browser Worker

The browser worker owns one isolated Chromium profile and a private Xvfb display. It exposes Chrome DevTools only on 127.0.0.1:9223, which is the existing Console MCP browser-control contract. It does not expose an MCP endpoint and does not own task state.

## Prerequisites

- Install a non-Snap Chromium-compatible browser, for example Google Chrome stable.
- Install Xvfb.
- Set CONSOLE_MCP_BROWSER_BIN in /etc/console-mcp/browser.env to the verified browser executable.
- Never use --no-sandbox.

## Install

1. Copy ops/ubuntu/config/console-mcp-browser.env.example to /etc/console-mcp/browser.env.
2. Set root:console-mcp ownership and mode 0640.
3. Run the systemd installer again; it installs both units.
4. Run sudo systemctl enable --now console-mcp-browser.service.
5. Confirm the CDP endpoint locally with curl http://127.0.0.1:9223/json/version.

The first login to ChatGPT is a controlled visual operation. Do not expose CDP or the virtual display to the public network. The next milestone will add a tunnel-only inspection path for that visual login and recovery.
