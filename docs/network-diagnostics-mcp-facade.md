# Network Diagnostics MCP — M1 façade and ChatGPT cutover

Status: **feature branch; not deployed**. Reconciles existing unmerged PR #173 (which introduced `/mcp/network`) with an opt-in primary ChatGPT visibility cutover; there must be no duplicate `/network/mcp` route. Vikunja NETMCP #92–97.

## Architecture

The canonical registration and handler ownership remain in the Console MCP. The opt-in network endpoint `/mcp/network` uses `CanonicalToolRegistry.forSecondToken("chatgpt", "network")` and the existing `chatGptFacadeProjections` router; its OAuth policy requires only `console:read` (unlike mutation-only repo/release/transport façades).

* `CONSOLE_MCP_NETWORK_FACADE_ENABLED=1`: enable the standard `/mcp/network` second-token façade, default OFF.
* `CONSOLE_MCP_NETWORK_FACADE_CUTOVER=1`: exclude exactly the admitted network façade tool names from the **main ChatGPT** tool projection, default OFF. This requires the façade enabled and fails during startup otherwise.
* Codex/runner projections, canonical registrations, and handlers remain unchanged.
* Visibility filtering prevents `tools/list` and `tools/call` for omitted names on the main endpoint; it does **not** disable their backend implementations.
* After activation, use *both* `/mcp/network` and primary `/mcp` endpoints to verify isolated lists and deny omitted tool calls.
* Rollback: disable cutover first, then disable the network façade only after verifying primary visibility.

## Current scope

At master baseline only `read_.network.http.probe` is admitted in the canonical registry. It is tightly allowlisted to specific addresses and does **not** provide arbitrary data-center device probing. The 20-operation infrastructure diagnostics draft (9 network operations) remains staged and unadmitted. Do **not** promote the draft without its platform regressions, security review and admission projections.

## Acceptance gates

1. `npm run build`; `node tool/network-facade-projection-regression.mjs`; `node tool/network-http-probe-regression.mjs`. Compare PR #173's previously reported `test:network-facade` results, but re-run tests on this exact candidate SHA.
2. Feature OFF: unchanged `/mcp` ChatGPT inventory; `/mcp/network` not routed.
3. Facade ON, cutover OFF: `/mcp/network` contains the admitted network subset; `/mcp` remains unchanged.
4. Facade ON, cutover ON: network subset removed from main `tools/list` and `tools/call`; accessible only through network; unrelated and Codex/runner inventories retained.
5. Cutover ON with façade OFF must prevent startup; invalid OAuth scope must fail closed; read-only OAuth scope must suffice for network endpoint.
6. Do not deploy before clean checkout build, authenticated HTTP integration smoke, current runtime fingerprint capture, and reversible release transaction.

Scope limitations: this phase introduces the façade and safe projection cutover, **not** arbitrary network scanning, SNMP, Redfish or OS configuration writes.
