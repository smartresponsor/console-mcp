# Transport MCP facade — Sprint 1 (review-only)

## Verified inventory (2026-11-09)
- Ubuntu Gold Console MCP: PID 214919, build fingerprint `01d7dbfd58d9602f`, registry fingerprint `52d7009f382dde7f`.
- `read_.system.console.describe` lists `write.transport.json.artifact`; the ChatGPT-visible Ubuntu tool set does not expose it. Health reports chatgpt/codex 299, runner 312; those are server-side projections, **not** proof of actual ChatGPT discovery.
- Canonical implementation: `src/tool/json-transport.ts`, `src/service/json-transport.ts`. Trusted destination alias `linkedin-mcp/inbox` is configured in `policy/json-transport-destinations.json`. Artifact payload must be a JSON object with a valid `batchId`; caller supplies the SHA256 of the pretty-printed JSON plus trailing newline. Delivery uses exclusive atomic linking and rejects collisions.
- PR #155 (Release facade) contains a fail-closed canonical allowlist, but explicitly lacks endpoint routing, OAuth metadata, HTTP integration and deployment. Its projection pattern is reused here.

## This branch
- `src/engine/transport-facade-tools.ts`: exact one-tool allowlist, rejecting absent canonical or unadmitted tools.
- `tool/transport-facade-projection-regression.mjs`: projection and rejection tests.
- An opt-in `/transport/mcp` path on the existing authenticated OAuth HTTP listener is implemented in `src/index.ts`; it reuses the canonical transport handler, authorization, admission and audit. The flag `CONSOLE_MCP_TRANSPORT_FACADE_ENABLED=1` is required and defaults off. No second delivery engine, new credentials, inbox mutations, new HTTP listener, or production cutover.

## Acceptance gates remaining
1. **Implemented in source, not yet HTTP-tested:** opt-in `/transport/mcp` on the existing OAuth profile and Streamable HTTP handler; verify that no non-transport tool can be listed or invoked.
2. Confirm OAuth challenge, authorization-server discovery, protected-resource metadata, and tools/list in a separate isolated HTTP integration test, then a real ChatGPT connector session. Validate write-scope enforcement before any delivery.
3. Send a uniquely identified, non-sensitive test JSON to a preapproved test inbox, verify SHA256, idempotency and durable receipt; do not write to the live LinkedIn inbox as a connectivity test.
4. Review and authorize deployment separately.

The tool-projection unit test is **not** a live connector test or delivery receipt.

## End-to-end HTTP integration evidence (2026-11-09)

- Commit `ae92b3e40b606066b9d87d46c608a138e4efae36`: isolated Ubuntu Gold checkout, `npm run build` PASS and `node tool/transport-facade-http-delivery-regression.mjs` PASS.
- The test calls `write.transport.json.artifact` through an OAuth-authenticated MCP `tools/call` against `/transport/mcp`. A temporary, isolated destination registry and inbox are used only in the dedicated validation checkout; the original registry is restored afterward.
- Durable file bytes and SHA-256 are checked, repeated delivery returns `TRANSPORT_ALREADY_DELIVERED`, and a same-batch conflicting payload returns `TRANSPORT_BATCH_COLLISION`.
- The test also checks OAuth metadata, read-scope rejection, exactly one published tool, non-transport invocation rejection, and canonical `/mcp` continuity.
- This is **not** evidence of ChatGPT connector discovery or of delivery to the live LinkedIn inbox. No production cutover.
- An unrelated `ops/ubuntu/deployment/__pycache__/` untracked directory was visible in the validation checkout from prior Python test execution; do not claim the checkout is entirely clean or delete it without reviewing ownership.
