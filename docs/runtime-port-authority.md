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
