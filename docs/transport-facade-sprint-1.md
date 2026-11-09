# Transport MCP facade — Sprint 1 (review-only)

## Verified inventory (2026-11-09)
- Ubuntu Gold Console MCP: PID 214919, build fingerprint `01d7dbfd58d9602f`, registry fingerprint `52d7009f382dde7f`.
- `read_.system.console.describe` lists `write.transport.json.artifact`; the ChatGPT-visible Ubuntu tool set does not expose it. Health reports chatgpt/codex 299, runner 312; those are server-side projections, **not** proof of actual ChatGPT discovery.
- Canonical implementation: `src/tool/json-transport.ts`, `src/service/json-transport.ts`. Trusted destination alias `linkedin-mcp/inbox` is configured in `policy/json-transport-destinations.json`. Artifact payload must be a JSON object with a valid `batchId`; caller supplies the SHA256 of the pretty-printed JSON plus trailing newline. Delivery uses exclusive atomic linking and rejects collisions.
- PR #155 (Release facade) contains a fail-closed canonical allowlist, but explicitly lacks endpoint routing, OAuth metadata, HTTP integration and deployment. Its projection pattern is reused here.

## This branch
- `src/engine/transport-facade-tools.ts`: exact one-tool allowlist, rejecting absent canonical or unadmitted tools.
- `tool/transport-facade-projection-regression.mjs`: projection and rejection tests.
- No second delivery engine; no new credentials, inbox mutations, HTTP listener, or production cutover.

## Acceptance gates remaining
1. Wire this allowlist to a **separate authenticated Streamable HTTP MCP surface**, using the existing Console MCP execution/admission/audit path; do not publish an unauthenticated public endpoint.
2. Confirm endpoint and OAuth discovery in a real ChatGPT connector session, including that only `write.transport.json.artifact` is visible.
3. Send a uniquely identified, non-sensitive test JSON to a preapproved test inbox, verify SHA256, idempotency and durable receipt; do not write to the live LinkedIn inbox as a connectivity test.
4. Review and authorize deployment separately.

The tool-projection unit test is **not** a live connector test or delivery receipt.
