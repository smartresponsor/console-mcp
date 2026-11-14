# MCP Efficiency Foundation — offline baseline

Target repository: `smartresponsor/console-mcp`, Gold/Silver Console MCP.
This is an **offline audit utility**, not a runtime modification.

## Usage

Run the dependency-free regression:

```sh
node tool/mcp-efficiency-baseline-regression.mjs
```

Analyze a private **copy** of an existing method trace:

```sh
node tool/mcp-efficiency-baseline.mjs /path/to/mcp-method-trace.ndjson 20 > baseline.json
```

The analyzer streams NDJSON input line-by-line without buffering the entire trace. The output reports per-consumer tool counts, errors, p50/p95 method elapsed time,
malformed lines, and unmatched start/end events. It excludes raw arguments,
response content and secrets. Source traces can contain operational identifiers;
keep them private and never commit logs or the resulting report.

## Existing implementation

- `src/engine/canonical-tool-registry.ts` already builds a canonical registry and fingerprints.
- `src/Infrastructure/Diagnostics/RuntimeDiagnostics.ts` already writes bounded rotated
  `mcp-method-trace.ndjson` and `mcp-request-trace.ndjson`.
- `src/index.ts` already traces tools/list and tools/call.
- No new cache, telemetry service, transport, API billable request, or registry implementation is needed.

## Limitations / next step

- `elapsed_ms` is **end-to-end request time**, not handler-only duration.
- Error rates are transport-visible errors only; application errors returned inside a successful tool result may not be counted.
- Response bytes are not presently available from method traces.
- An offline trace snapshot is necessary for a trustworthy baseline.
- Adding `response_bytes` should be a separate, opt-in extension to existing
  diagnostics after a real baseline, **without changing tool response payloads**.
- Browser MCP on Chromebook has exposed sessions but not equivalent host-level metrics.
- Run checks locally. GitHub Actions results are not acceptance evidence for this track.
- Production and dirty worktrees must remain untouched.

Symfony integrations (if required later): Symfony 8, PHP 8.4, default `App\` namespace only.

## Optional response-body measurement (new, disabled by default)

Set `CONSOLE_MCP_RESPONSE_BYTES_TRACE=1` in an explicitly approved test runtime
to add `response_body_attempted_bytes` to existing `mcp-request-trace.ndjson`
POST records. This is **not enabled** by merging code or running the offline analyzer.

The measurement counts response body chunks passed to Node HTTP `write` and
`end`; it excludes HTTP headers, chunk transfer framing, TLS, compression,
and client-side receipt. On interrupted responses it remains an attempted-byte
count. No body content or tool arguments are recorded. The `response_finish_fired`
and `response_aborted` fields distinguish completed vs interrupted writes.

Local regression (requires a normal project build):

```sh
npm run build
node tool/response-body-measurement-regression.mjs
```

Observe request traces and method traces by `correlation_id` only when authorized
to read both log sets. Avoid combining unmatched or concurrent tool calls into
per-tool body counts without an unambiguous request-to-method relationship.
