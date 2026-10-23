# Runtime Port Authority

This document is the human-readable port authority for Console MCP-managed local runtimes.
Source-code defaults remain executable proof; this document must mirror them.

## Canonical ports

| Port | Runtime | Authority / health surface |
| ---: | --- | --- |
| `3333` | Console MCP ChatGPT OAuth endpoint | `http://127.0.0.1:3333/mcp` |
| `3334` | Console MCP Codex bearer endpoint | `http://127.0.0.1:3334/mcp` |
| `8000` | **Canonical local Symfony/App host** | `read_.runtime.php.server.status`, `write.runtime.php.server.restart`, `read_.http.localhost.inspect` |
| `8080` | **Mobiling mobile-edge runtime** | `read_.runtime.mobile.edge.server.status`, `/health` |
| `9223` | Primary managed browser DevTools/CDP listener | browser/watchdog runtime |
| `9222` | Reserved standby/compatibility DevTools/CDP listener | browser/watchdog runtime |

## App host rule

The assembled Symfony host application under `D:\PhpstormProjects\www\App` uses
`http://127.0.0.1:8000/` as the canonical persistent local-host address.

Console MCP executable defaults prove this contract:

- `src/tool/local-php-server.ts` defaults the managed PHP server to port `8000`;
- `src/tool/localhost.ts` defaults localhost inspection to `http://127.0.0.1:8000/`.

Do **not** use port `8080` for the Symfony/App host. Port `8080` belongs to the Mobiling
`mobile-edge` development runtime; `src/tool/mobile-edge-server.ts` owns that default.

When no explicit port is supplied, Console MCP runtime tools must therefore be interpreted as:

```text
Symfony/App local host -> 127.0.0.1:8000
Mobiling mobile-edge   -> 127.0.0.1:8080
```

## Change discipline

Changing one of these canonical ports is an architecture/runtime-contract change. A port change
must update, in the same change set:

1. the executable default in the owning Console MCP runtime tool;
2. this authority document;
3. relevant watchdog/runtime configuration;

## Ubuntu remote-desktop allocation contract (2026-10-20)

- Ubuntu host: `alex-HP-Spectre-x360-Convertible-15-df1xxx`; Ubuntu 24.04.4 LTS; GNOME 46.
- Reserve **TCP/3389 exclusively for system GNOME Remote Login** (new graphical session).
- Reserve **TCP/3390 exclusively for GNOME Desktop Sharing** (the existing `alex` desktop/session).
- Use a dedicated remote Linux account for independent GNOME Remote Login when the physical `alex` session must remain running. Logging into the same already-active account can offer to terminate that local session; it is **not** guaranteed parallel access to a single user profile.
- When both features are enabled, Ubuntu GNOME's documented behavior is 3389 for Remote Login and 3390 for Desktop Sharing. Do not assume 3390 is present if Remote Login is disabled or if the settings are overridden.
- Do **not** start `xrdp` on 3389 or 3390 concurrently with GNOME Remote Desktop. An alternative daemon needs a separately reviewed port/architecture decision.
- Neither port should be exposed directly to the public internet; route remote iPad access through an authenticated private network (e.g. Tailscale), with firewall scope restricted to the chosen interface.
- Do not change GNOME desktop/session ownership or restart the supervised visible Edge session or primary background browser. Ports 9223/9224 are separate browser CDP endpoints, not RDP.
- Runtime validation: `pwsh -NoProfile -File tool/ubuntu-remote-desktop-audit.ps1` from this repository, followed by host-side `grdctl --system status`, desktop user `grdctl status`, and `ss -ltnp`/RDP client smoke checks. Run GNOME commands in their respective security and D-Bus contexts; the `console-mcp` service context does **not** represent `alex`'s settings.
- **Observed state 2026-10-20 16:35 UTC:** loopback TCP probes report neither 3389 nor 3390 listening. 9223 and 9224 are listening. GNOME Remote Desktop 46.3 is installed, GDM active, system `gnome-remote-desktop.service` active/enabled, `xrdp` absent, physical `alex` desktop session active. `console-mcp` cannot run sudo (no-new-privileges), so system RDP options and `alex` Desktop Sharing settings are **not verified**. This is a reservation contract, **not** evidence of live RDP service or remote reachability.
- Acceptance for **ACTIVE**: both listeners bound to the expected GNOME RDP owner on their exact TCP ports, successful authenticated iPad/client connection to each role, Edge 9223/9224 unchanged, and no direct internet exposure. Until proven, status remains **RESERVED / NOT ACTIVE**.

Official reference: https://ubuntu.com/desktop/docs/en/24.04/how-to/share-your-desktop-remotely/

## App host rule

The assembled Symfony host application under `D:\PhpstormProjects\www\App` uses
`http://127.0.0.1:8000/` as the canonical persistent local-host address.

Console MCP executable defaults prove this contract:

- `src/tool/local-php-server.ts` defaults the managed PHP server to port `8000`;
- `src/tool/localhost.ts` defaults localhost inspection to `http://127.0.0.1:8000/`.

Do **not** use port `8080` for the Symfony/App host. Port `8080` belongs to the Mobiling
`mobile-edge` development runtime; `src/tool/mobile-edge-server.ts` owns that default.

When no explicit port is supplied, Console MCP runtime tools must therefore be interpreted as:

```text
Symfony/App local host -> 127.0.0.1:8000
Mobiling mobile-edge   -> 127.0.0.1:8080
```

## Change discipline

Changing one of these canonical ports is an architecture/runtime-contract change. A port change
must update, in the same change set:

1. the executable default in the owning Console MCP runtime tool;
2. this authority document;
3. relevant watchdog/runtime configuration;
