# Network MCP — canonical runtime and projection ownership contract

**Status:** Architecture gate for M1.3 / Vikunja #105. Applies before new network diagnostic tools are registered.

## One runtime, one canonical registration

- Add every diagnostic command to the existing `console-mcp` canonical registry, not a separate server implementation. Ubuntu Gold is first. Windows Silver will use the same registration and tool contract with OS-specific implementations/capability gating.
- `Network Facade MCP` is only a consumer-specific projection/transport of that canonical registry. It must never fork tool handlers, admission, policies or credentials.
- Linux, Windows and other nodes must report `supported / unsupported / permission-required` explicitly for hardware and driver capabilities; no fabricated data.

## Exclusive ChatGPT ownership: fail closed

1. All new commands must be named `read_.network.*`, admitted to the canonical registry once, and projected to ChatGPT **only** through `/mcp/network` (OpenAI Tunnel over the existing protected Unix socket).
2. The main ChatGPT `/mcp` projection must not contain any `read_.network.*` names. This is an invariant, not a later optional migration. Production currently sets `CONSOLE_MCP_NETWORK_FACADE_CUTOVER=1`.
3. **Before adding a second Network command**, update the runtime so that registration fails closed when the Network Facade, exclusive projection, or required transport is disabled/misconfigured. Do not rely on remembering to turn a cutover flag on after deployment.
4. Keep canonical Codex/runner admission unchanged unless a separately reviewed policy explicitly restricts them; their access is not a second ChatGPT-facing MCP connector.
5. A new command is not accepted until an isolated integration test verifies both positive and negative paths: the exact name appears in Network Facade `tools/list`, does **not** appear in main ChatGPT `tools/list`, cannot be invoked via main ChatGPT `tools/call`, and remains handled by the same canonical implementation.
6. Maintain exact Network name manifest and schema fingerprints. No wildcard adoption of `write.network.*`; Network Facade is read-only. Authenticated sessions are permitted only for bounded, approved read-only endpoint diagnostics.
7. Network Tunnel identity, socket ACL, secrets, audit policy and rollback gates remain unchanged. Do not deploy if main and facade projections overlap.

## Implementation sequence

- **PR #216:** only passive Node/OS inventory primitives, without MCP registration. They cannot leak into ChatGPT tool discovery.
- **Next code change:** explicit Network ownership projection + fail-closed gate + main/facade HTTP regression tests **before** adding inventory tools to the registry.
- **Then:** register `read_.network.host.interfaces` and `read_.network.serial.inventory` once and expose them via the Network Facade only. Verify cross-OS availability and keep existing production untouched until all CI/release checks pass.
- **Future write plane:** independent service identity and approval/security boundary, not write operations in the Network read-only facade.

## Acceptance matrix

| Environment | Canonical implementation | Main ChatGPT /mcp | ChatGPT /mcp/network | Codex / runner |
|---|---|---|---|---|
| Ubuntu Gold | Single existing Console MCP runtime | Network commands absent | Network commands present | Stable canonical admission |
| Windows Silver | Same Console MCP code / OS-specific adapters | Network commands absent | Network commands present once endpoint deployed | Stable canonical admission |
| No network facade / invalid exclusive projection | Do **not** start a runtime exposing newly admitted Network commands to ChatGPT | Fail closed | No exposure | Existing unrelated tools remain unaffected |

**Rule:** Never publish a newly admitted network command to main ChatGPT even temporarily.