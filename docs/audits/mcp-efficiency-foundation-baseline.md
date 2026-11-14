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

The output reports per-consumer tool counts, errors, p50/p95 method elapsed time,
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
- Response bytes are not presently available from method traces.
- An offline trace snapshot is necessary for a trustworthy baseline.
- Adding `response_bytes` should be a separate, opt-in extension to existing
  diagnostics after a real baseline, **without changing tool response payloads**.
- Browser MCP on Chromebook has exposed sessions but not equivalent host-level metrics.
- Run checks locally. GitHub Actions results are not acceptance evidence for this track.
- Production and dirty worktrees must remain untouched.

Symfony integrations (if required later): Symfony 8, PHP 8.4, default `App\\` namespace only.
