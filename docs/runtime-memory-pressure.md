# Windows code-memory pressure: evidence, containment and authorization

Production cutover remains **BLOCKED**. This document separates live mitigation,
isolated verification and the remaining authorization conditions.

## Evidence and cause

The installed executable reports v0.8.1 and has SHA-256
`b67a67cf4846a66f6c6830c48885e1dac6e9e09ae4536423f471f075611071fe`.
It exactly matches the executable extracted from the official UI Windows release.
The release ZIP hash is
`3219a73ef6e7907efcfa070cef88e39d2a020b6ebd98fc6a8963f704ac7a72c7`,
matching GitHub's asset digest. Reviewed source tag v0.8.1 resolves to
`f0c9be19c5d74b84f418d807bfdce7b5d6a261ff`.

Windows Resource-Exhaustion-Detector Event 2004 recorded code-memory instances
near 66.3 GB private commitment, including PID 14128 on October 28 at 04:55:50
and 05:00:50 UTC. Other PIDs appeared in earlier incidents; that establishes
repeated instances, not simultaneous indexing concurrency.

The replacement PID 27152 started at 05:01:56 UTC. Its live UI log recorded:

```text
session.root.cwd path=C:\Users\Admin
autoindex.start project=C-Users-Admin path=C:\Users\Admin
pipeline.discover files=1127499 elapsed_ms=811077
pipeline.route path=full
```

Its private bytes grew from about 523 MB to **33,640,644,608 bytes** during this
investigation. At the latter sample only about 2.5 GB physical memory remained.
This is direct evidence of an excessive auto-indexing workload, not a theory
based only on the old process name.

Three defects in the exact release explain why it was admitted:

1. `detect_session()` compares native Windows CWD against a home path normalized
   to forward slashes using a case-sensitive string comparison. The log proves
   the home-directory exclusion failed on this machine.
2. `maybe_auto_index()` runs a POSIX shell pipeline with single-quoted paths,
   `/dev/null` and `wc -l`. On Windows its failure does not block admission. The
   configured 50,000-file precheck did not prevent discovery of 1,127,499 files.
3. `cbm_mem_over_budget()` measures resident memory and the extractor's bounded
   backpressure loop eventually proceeds with a soft overshoot. It neither caps
   Windows committed memory nor aborts an oversized discovery/graph workload.

Primary source:
[session and auto-index admission](https://github.com/DeusData/codebase-memory-mcp/blob/v0.8.1/src/mcp/mcp.c),
[memory budget](https://github.com/DeusData/codebase-memory-mcp/blob/v0.8.1/src/foundation/mem.c),
[extractor backpressure](https://github.com/DeusData/codebase-memory-mcp/blob/v0.8.1/src/pipeline/pass_parallel.c).

The source serializes indexing pipelines with a mutex. No evidence establishes
an unbounded query cache or concurrent pipelines as the primary cause. A separate
allocation leak is not ruled out: no heap dump from the dead 66.3 GB process is
available. The oversized full-profile index is the confirmed trigger; exact
allocation-level attribution remains unverified. Codex's retained stderr stopped
at an invalid-UTF-8 warning, so the live UI ring supplied the indexing evidence.

## Live mitigation performed

The supported CLI setting `auto_index` was changed from `true` to `false` and
read back. This affects future automatic work; it cannot cancel an existing index.
No home-project database existed after the incident, so the already-indexed
project watcher shortcut cannot re-register that home index on the next start.

After saving executable identity, parent, creation time, memory and indexing
evidence, only PID 27152 was terminated. The PID/executable/parent/creation-time
checks preceded termination. Existing per-project databases were preserved.
Committed system memory subsequently fell to about 12.8 GB and available physical
memory recovered to about 27.4 GB. The executable itself was not upgraded or patched.

Production Watchdog PID 30820 independently replaced runtime PID 41864 with
PID 20940 (created 05:25:57 UTC; startup event 05:26:15 UTC), before retirement of
the code-memory process. Its log names failed local Codex readiness/token checks
as the replacement reason. Memory pressure was concurrent; the exact causal link
to that readiness failure is not proven. No production start/stop/restart command
was issued. The same Watchdog remains operational; authenticated health of the
replacement is verified separately. SSH and Tailscale were not restarted.

## Bounded gateway

`code-memory-bounded-gateway.mjs` is a staged, opt-in stdio adapter. It uses a
private cache, neutral CWD, automatic indexing disabled, and UI disabled. It
requires an executable hash and explicit workload policy. Index requests require
an exact allowlisted real root; the home directory is always refused. Queries
against already indexed projects remain available.

Only one request is admitted at a time; there is no waiting request queue.
Concurrent requests receive a busy error and must retry after completion.
Worker count, frame sizes, response sizes, timeouts and committed-memory budget
are explicit. Input/output pipes apply backpressure; telemetry retains only
32 samples and overwrites a bounded JSON snapshot. Tokens and source contents
are not written to telemetry.
Executable and release-file verification streams SHA-256 in 64 KiB chunks; the
270 MB installed binary is no longer read into one verification buffer.

The Windows host assigns the child to a kill-on-close Job atomically at process
creation using a Job-list attribute, then resumes it. This also bounds children
and kills descendants if the native host dies. See Microsoft's
[process-creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
and [Job memory limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information).
The host/compiler and gateway have separate fixed overhead; the configured Job
budget describes the backend tree, not total machine commitment.

Before an admitted index, the adapter makes a consistent SQLite backup and
flushes an index-recovery journal. Backend exit or interrupted startup restores
the previous snapshot after the backend is gone. An in-flight request fails
explicitly and is never replayed automatically. Reconnect starts a fresh contained
backend. A live controller lock is never stolen; ambiguous ownership fails closed.
The adapter depends on the tested Node v24.12 SQLite backup API, currently marked
experimental by Node. Existing global caches are not silently migrated.
Snapshot recovery is verified for admitted explicit index requests. The legacy
binary can still watch successfully indexed Git roots; that activity remains
inside the same Job budget, but its cache-durability and latency behavior must
also be covered by the representative Git-project soak before gateway activation.

The resource pilot uses 1,000 TypeScript files, one worker, 100 repeated queries
and a 40-request burst. It measured about 498 MB peak backend Job memory, released
most index memory afterward, and rejected 39 burst requests without queuing them.
A 2 GiB pilot safety ceiling leaves headroom for that fixture. It is **not** an
approved limit for every platform repository; no global process cap was installed.
Representative project sizes, concurrent clients and latency requirements must
be profiled before choosing a production budget and worker count.

Synthetic allocation-failure tests use a separate 96 MiB Job. The allocating
process fails and descendants are cleaned up. This Windows build reports a peak
counter roughly 5–8 MiB above that threshold; the cause of that accounting excess
is not established. Evidence records it and the regression bounds its envelope
by one 8 MiB fixture allocation. Do not describe this as zero-overshoot proof.

## Reproduction and recovery

```powershell
npm run test:runtime-memory
npm run test:runtime-routing
npm run test:runtime-version
pwsh -NoProfile -File tool/runtime-memory-telemetry.ps1 -OutputFile C:/evidence/memory.json
```

Tests use temporary caches/workspaces and isolated ports. They never launch a
second unbounded scan of the real home directory. Configuration for the gateway
contains `base`, `executable`, `executableSha256`, `allowedRoots`, `memoryBytes`,
`workers`, `frameBytes`, `responseBytes`, `timeoutMs`, and a `budgetEvidence`
description. The base must exist and its private cache/session paths cannot be
redirected by symlinks. Start with:

```powershell
node tool/code-memory-bounded-gateway.mjs C:/private/gateway.json
```

On memory failure, preserve telemetry and the recovery journal, close the failed
session, correct workload scope or its measured resource policy, then reconnect.
Do not retry the same oversized root automatically. Do not delete a live lock or
resume legacy home indexing. Keep `auto_index=false` even when removing the
experimental adapter. The current Codex connection was not silently replaced
with the pilot gateway; full-cache migration and budget calibration remain gates.

## Exact conditions before requesting production authorization

- Keep legacy automatic home indexing disabled and verify there is no runaway
  code-memory process. Profile representative real projects, approve a budget
  with machine commit/physical reserve, migrate consistent cache snapshots, and
  validate the bounded gateway for a representative soak interval.
- Demonstrate a successful opt-in validation action from an isolated active-console
  Watchdog broker. Session-0 refusal is tested; it is not a positive interactive
  broker result. The production Watchdog has not loaded the new code.
- Complete OAuth/public metadata and canonical-port handoff/rollback in a replica,
  including outstanding requests, process discovery/freshness and proxy ownership.
  The isolated stateless bearer router is implemented and tested; the existing
  production launch path still uses its fixed entry.
- Validate HWND denial with two real interactive sessions. Only console session
  7 was available; the gate remains BLOCKED.
- Approve the exact signed release/controller hashes, Node version, complete
  dependency inventory, filesystem ACLs and source/build attestation. Test storage
  crash durability if power-loss recovery is part of the deployment contract.
- Obtain explicit authorization for the reviewed production deployment sequence,
  with a maintenance window, health gates and the previous release/process/routing
  rollback plan. Do not infer merge, Watchdog restart, or cutover authorization
  from passing isolated tests or from this PR.
