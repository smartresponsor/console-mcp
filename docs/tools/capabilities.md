# Console MCP Capability Classes

This document describes console MCP capability classes for target ChatGPT conversations running inside an outer browser product loop.

It is intentionally not a full tool list. Tool catalogs evolve. Prefer capability classes and current tool discovery over hard-coded exhaustive enumerations.

## Hard exclusion for target conversations

The target conversation must not call `write.browser.session.cmcp.go`.

That tool starts the outer browser orchestration loop. It is owned by the runner, not by the product conversation.

Normal product work should also avoid browser transport and engine transport tools unless the task is explicitly about diagnosing the loop itself.

Examples of orchestration or transport surfaces that are outside normal product work:

```text
write.browser.session.cmcp.go
write.browser.chatgpt.chat.create.send
write.browser.session.open
write.browser.session.input.draft
write.browser.session.submit
write.engine.*
```

## Read capability classes

For repository engine tasks, repository access is Console-MCP-first and mandatory. Resolve the task's Windows workspace through `read_.repo.workspace.scope.resolve` or another appropriate `read_.repo.*` capability before drawing any conclusion about repository availability.

Never use ChatGPT/container filesystem probes such as `/mnt`, `/mnt/data`, `/workspace`, or `/workspaces` as an availability test for a Windows workspace managed by Console MCP. Failure to find a corresponding container mount is not evidence that the repository is unavailable. Treat a workspace as blocked only after the relevant Console MCP repository capability returns a real failure or the connector does not expose the required capability.

Read capabilities may be used freely when relevant to the requested workspace and task.

Useful read classes include:

```text
read_.repo.*
read_.package.*
read_.runtime.*
read_.framework.*
read_.database.sql.*
read_.github.workflow.*
read_.policy.*
read_.release.*
```

Common product-loop uses:

- inspect repository status, branch, HEAD, diffs, logs, and files;
- read Markdown, AsciiDoc, manifests, scripts, tests, CI, config, and policy files;
- inspect memory graph scope and architecture context;
- inspect package and framework checks when available;
- inspect PostgreSQL/MySQL/SQLite materialized database state through guarded read-only SQL and diagnostics tools;
- inspect runtime status when relevant to the implementation decision;
- inspect GitHub workflow failures when they are part of the task.

Database read tools are evidence providers only. `read_.database.sql.postgres.query`,
`read_.database.sql.postgres.diagnostics`, `read_.database.sql.sqlite.query`, and
`read_.database.sql.sqlite.diagnostics` must reject mutation, multi-statement SQL, and
secret-bearing output. SQLite databases are selected through configured aliases or workspace
configuration, never arbitrary model-supplied filesystem paths.

## Safe write capability classes

Safe write capabilities may be used when local evidence supports action and repository state is protected.

Typical safe write classes include:

```text
write.repo.file.replace.text
write.repo.patch.apply
write.repo.git.commit.signed
write.repo.git.push.current
write.repo.git.push.current.set.upstream
write.package.*
write.framework.*
write.runtime.*
```

Use the narrowest write capability that fits the task.

Safe writes are intended for coherent product work: focused source changes, focused documentation changes, focused tests, generated-safe materialization when explicitly owned by the repository, local verification, and signed commits.

## Mutation discipline

Before writing, understand the relevant current state enough to avoid damaging user work.

After writing, inspect the resulting diff and run relevant local checks when available and proportional.

Commit only coherent changes. Commit messages should describe the product change, not the transport mechanism.

Do not commit secrets, generated caches, vendor trees, node_modules, runtime transcripts, or unrelated local edits.

## Dirty-state handling

Dirty state requires classification, not automatic rejection.

Classify dirty state using repository status, diff, and file context. Treat valuable user work as protected.

Appropriate outcomes include preserving a coherent dirty change in a signed commit, narrowing the edit scope around unrelated work, or reporting that no safe mutation can be made without user direction.

For authorized integration work, a dirty tree or ahead/behind divergence is not itself a reason to refuse publication. Inspect branch/upstream and remote state, preserve unrelated work in place, and use guarded fetch/rebase/fast-forward/push capabilities when they can complete publication without destructive cleanup or semantic commingling.

Destructive cleanup is outside the default boundary.

## GitHub and runtime tools

GitHub workflow and runtime tools are context tools. Use them when they help explain a failure, verify an implementation, or choose the next safe action.

For local runtime port authority, use `docs/runtime-port-authority.md`. In particular, Console MCP's managed Symfony/App host defaults to `127.0.0.1:8000`, while Mobiling `mobile-edge` defaults to `127.0.0.1:8080`; these are distinct runtime contracts and must not be substituted for each other.

Do not use GitHub as a substitute for the authoritative local repository when the task is local implementation. Inspect local state through Console MCP first; use GitHub only when the task requires remote integration or remote evidence.

## Symfony and package tools

For Symfony/PHP repositories, prefer existing repository scripts and configured checks.

Potential evidence sources include Composer manifests, Symfony configuration, container or service diagnostics, PHP syntax checks, static analysis, tests, Doctrine validation, and repository-local gates.

The available exact tools depend on the active connector schema. Use current tool discovery and repository-local scripts as source of truth.

## Output contract preference

When reporting results, prefer a compact structured summary:

```json
{
  "status": "...",
  "summary": "...",
  "actionsTaken": [],
  "filesChanged": [],
  "checksRun": [],
  "commit": null,
  "risks": [],
  "nextAction": "..."
}
```

This is a reporting preference. It does not restrict the model's internal planning strategy.
