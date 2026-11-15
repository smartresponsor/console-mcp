# MCP Efficiency Foundation — offline baseline

Target repository: `smartresponsor/console-mcp`, Gold/Silver Console MCP.
This PR contains an **offline audit utility** and an **opt-in runtime telemetry extension**, disabled by default.

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
- No new cache, telemetry service, transport, API billable request, or registry implementation is introduced.

## Limitations / next step

- `elapsed_ms` is **end-to-end request time**, not handler-only duration.
- Error rates are transport-visible errors only; application errors returned inside a successful tool result may not be counted.
- Response bytes are not presently available from method traces.
- An offline trace snapshot is necessary for a trustworthy baseline.
- The optional `response_body_attempted_bytes` extension is included in this PR and
  remains disabled unless explicitly enabled; it does not change tool response payloads.
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

## Consumer and traffic-origin segmentation (offline, opt-in)

Run per-consumer breakdowns on host-local traces:

```sh
node tool/mcp-efficiency-baseline.mjs /path/to/mcp-method-trace.ndjson 30 --consumer=chatgpt > chatgpt-baseline.json
node tool/mcp-efficiency-baseline.mjs /path/to/mcp-method-trace.ndjson 30 --consumer=codex > codex-baseline.json
```

The filter is **exact**, and records omitted from the selected scope are counted as `trace_events.filtered_events`. The analyzer also reports `traffic_origins` for **explicitly present** `traffic_origin` method-trace values, with historical untagged events recorded as `unclassified`. If a future runtime emits an audited origin tag, select it with `--traffic-origin=supervisor_smoke`.

**Do not label all historical Codex events as supervisor smoke** or infer provenance from tool names, user-agent, cadence, or the 5-operation signature. Current method traces lack dependable source tagging. `--consumer=chatgpt` gives the ChatGPT-only workload baseline, **not** a complete human-user baseline (genuine Codex calls are excluded). Do not call a count of zero trace-visible errors proof that tools returned successful business outcomes.

### Silver investigation (2026-11-14)

The roughly 34-second repeating five-operation sequence in the Silver trace is attributable to the Windows `console-mcp-watchdog` local authentication smoke lane. Source chain: `watchdog-task-bootstrap.ps1` → `watchdog-loop-run` in `tool/dev-console.d/46-watchdog-broker-loop.ps1` → `local_auth=30` seconds in `45-watchdog-cadence.ps1` → `Invoke-CodexSmoke` in `54-smoke-probes.ps1` → short-lived `Invoke-NodeMcpSmoke` in `70-smoke.ps1`. This probe performs `tools/list` plus `console.describe`, `workspace.status`, `console.health` and `gate.check.run`. The user observed 12,964 `tools/list` calls with median 34-second interval, and 12,949 of 12,963 gaps fell in 30–39 seconds. This is **primarily synthetic health traffic**, not a valid representation of normal Codex activity.

The 30-second cadence and watchdog remain unchanged. Future per-request origin tagging would require separate design, tests and review to ensure that the origin is bound to the authenticated client/session without allowing a caller to spoof trustworthy telemetry.

