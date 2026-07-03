# Console MCP Engine

This document defines the CLI-first engine milestone for `console-mcp`.

## Decision

Move the control plane from LLM-driven orchestration to a local deterministic engine inside the existing Node/TypeScript repository.

The default entry point becomes CLI. MCP remains as a transport and observability layer. LLM/ChatGPT remains useful, but it becomes one executor and fallback path, not the center of the workflow.

Target flow:

```text
CLI / MCP / future external entry point
        -> engine task queue
        -> engine worker
        -> executor
        -> event log / status
```

## Existing repository boundary

Reuse what already exists:

- `tool/dev-console.ps1` as the Windows command surface.
- `package.json` scripts for status, restart, watchdog, smoke, typecheck, build, and regression.
- `docs/chatgpt-run-loop-orchestration.md` as the current controlled browser run-loop contract.
- `var/run/`, `var/log/`, and `var/transcript/` runtime areas.
- `policy/console-tool-catalog-*.json` for tool catalog governance.
- `policy/allowed-check.json` for approved execution checks.
- `src/tool/*` and `src/service/*` as the current MCP and service implementation.

Do not replace the current MCP server. Do not introduce Symfony yet. Do not remove the Ask tool. Ask remains a cheap LLM support path.

## Main principle

The engine must be auditable and resumable:

```text
Command -> Task -> State -> Event -> Decision -> Action -> Event
```

The event log is the source of truth. Any failure must be explainable from events.

## Proposed source layout

```text
src/engine/
  engine-task.ts
  engine-event.ts
  engine-state.ts
  engine-command.ts
  engine-task-store.ts
  engine-event-store.ts
  engine-lock.ts
  engine-worker.ts
  engine-decision.ts
  engine-policy.ts
  engine-cli.ts
```

Concrete executors:

```text
src/engine/executor/
  chatgpt-browser-executor.ts
  repo-check-executor.ts
  repo-patch-executor.ts
  git-executor.ts
  ask-executor.ts
```

No port/adapter split is required. Keep direct service-oriented TypeScript code.

## Runtime layout

```text
var/run/engine/
  task/
  lock/
  worker/
  session/

var/log/engine/
  event.jsonl
  worker.jsonl
  error.jsonl
```

Keep existing `var/run/chatgpt-run-loop/<runId>/` until it is wrapped by engine state.

## CLI contract

Required CLI commands:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 engine status
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 engine go cataloging
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 engine task-status <task-id>
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 engine event-tail <task-id>
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 engine tick
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 engine worker-start
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 engine worker-stop
```

Optional npm aliases:

```json
{
  "engine": "node --enable-source-maps dist/engine/engine-cli.js",
  "engine:status": "node --enable-source-maps dist/engine/engine-cli.js status",
  "engine:tick": "node --enable-source-maps dist/engine/engine-cli.js tick"
}
```

## MCP symmetry

MCP should expose thin wrappers over the same engine services:

```text
console.write.engine.task.enqueue
console.read_.engine.task.status
console.read_.engine.task.list
console.read_.engine.event.tail
console.write.engine.worker.tick
console.read_.engine.worker.status
```

The wrappers must not duplicate orchestration logic.

## Repo RC command contract

The first target command is:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 engine go cataloging
```

It resolves to:

```text
workspace: D:\PhpstormProjects\www\cataloging
component: Cataloging
preset: repo_rc_implementation
task_class: repo_rc_implementation
```

## Safety and determinism

- One tick performs at most one state-changing action per task.
- Every state-changing action requires a task lock.
- No arbitrary shell execution.
- Existing approved checks and guarded repo tools remain the execution boundary.
- Every blocked state must include a reason and next safe command.
