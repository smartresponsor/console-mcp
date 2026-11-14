# ADR: Canonical MCP facades over OpenAI Tunnel

Status: Accepted architecture; transport rollout requires verification
Date: 2026-11-14
Scope: Ubuntu Console MCP and future node-specific facades

## Decision

1. **One canonical tool implementation.** Console MCP owns each tool handler, schema, tool admission policy, audit trail, and browser/session coordination. Facades expose filtered projections of that registry; no duplicated handlers, state ownership, or forked browser runtimes.
2. **Capability-scoped facades.** Browser, Repository, Runtime, and future network/release/transport capabilities are grouped by purpose. The Browser facade is a whole tool group, **not just** `write.browser.tab.close`.
3. **OpenAI Tunnel is the preferred transport to ChatGPT.** Do not introduce Cloudflare as the default dependency for new facades. Keep the local facade endpoint and the remote connector identity explicit and independently testable.
4. **No unnecessary second OAuth layer.** Skip redundant OAuth only if the OpenAI Tunnel and connector demonstrably provide authenticated transport, caller isolation, and tool-level write authorization. Until proven, retain OAuth and `console:write` enforcement. **Never expose unauthenticated MCP HTTP on a public interface.**
5. **Canonical safety is non-negotiable.** Route all calls through original admission and tool guards, preserving explicit confirmation, browser target binding, login/form/last-tab protections, audit evidence and rollback controls.
6. **No architecture fork.** Existing protected OAuth routes remain compatible during migration, but the desired connector architecture must not become separate, permanently duplicated codebases.

## Implementation facts at acceptance

- Release `33b6d190bb62eb4a5c712460d8c085481b95574d` passed Browser facade HTTP tests with **51** admitted browser tools, Repository facade with 69, Runtime facade with 15. These are point-in-time test counts, not permanent contract limits.
- `write.browser.tab.close` is one tool in the canonical Browser facade; it is not the reason to create a single-tool service.
- The live `/mcp/browser` OAuth endpoint responded with HTTP 401 and `console:write` scope. This establishes current protected HTTP routing, **not** an active OpenAI Tunnel mapping.
- A previously installed OpenAI Tunnel for another worker does not prove that this particular Browser facade is connected to it.

## Required rollout gates

1. Inventory the actual installed tunnel client, local/public endpoint mapping, service ownership, authentication contract and connector credentials. Distinguish installed, configured and connected.
2. Test connector identity, lack of cross-facade enumeration, scope enforcement, direct/public bypass denial, and read/write separation.
3. Compare `tools/list` for each deployed facade to canonical registry projections and verify schemas, counts and lifecycle admission dynamically.
4. Run read-only CDP/browser checks first; mutate only disposable test targets and prove existing windows and tabs remain unchanged.
5. Preserve protected production release/rollback checkpoints. Do not restart browser/production or weaken policy as a side-effect of this ADR.
6. Document evidence, recovery, secret rotation, cutover and rollback before enabling the tunnel-backed connector as default.

## Consequences

- Future Ubuntu/Windows/Chromebook facades follow the same pattern where applicable.
- No automatic inference that 'without OAuth' means 'without authentication'.
- Any deviation requires explicit, reviewed architectural decision and regression coverage.
