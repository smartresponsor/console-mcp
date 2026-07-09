# Console MCP Capability Classes

This document describes console MCP capability classes for target ChatGPT conversations running inside an outer browser product loop.

It is intentionally not a full tool list. Tool catalogs evolve. Prefer capability classes and current tool discovery over hard-coded exhaustive enumerations.

## Hard exclusion for target conversations

The target conversation must not call `console.write.browser.session.cmcp.go`.

That tool starts the outer browser orchestration loop. It is owned by the runner, not by the product conversation.

Normal product work should also avoid browser transport and engine transport tools unless the task is explicitly about diagnosing the loop itself.

Examples of orchestration or transport surfaces that are outside normal product work:

```text
console.write.browser.session.cmcp.go
console.write.browser.chatgpt.chat.create.send
console.write.browser.session.open
console.write.browser.session.input.draft
console.write.browser.session.submit
console.write.engine.*
```

## Read capability classes

Read capabilities may be used freely when relevant to the requested workspace and task.

Useful read classes include:

```text
console.read_.repo.*
console.read_.package.*
console.read_.runtime.*
console.read_.framework.*
console.read_.github.workflow.*
console.read_.policy.*
console.read_.release.*
```

Common product-loop uses:

- inspect repository status, branch, HEAD, diffs, logs, and files;
- read Markdown, AsciiDoc, manifests, scripts, tests, CI, config, and policy files;
- inspect memory graph scope and architecture context;
- inspect package and framework checks when available;
- inspect runtime status when relevant to the implementation decision;
- inspect GitHub workflow failures when they are part of the task.

## Safe write capability classes

Safe write capabilities may be used when local evidence supports action and repository state is protected.

Typical safe write classes include:

```text
console.write.repo.file.replace.text
console.write.repo.patch.apply
console.write.repo.git.commit.signed
console.write.repo.git.push.current
console.write.repo.git.push.current.set.upstream
console.write.package.*
console.write.framework.*
console.write.runtime.*
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

Destructive cleanup is outside the default boundary.

## GitHub and runtime tools

GitHub workflow and runtime tools are context tools. Use them when they help explain a failure, verify an implementation, or choose the next safe action.

Do not use them as a substitute for inspecting the local repository when the task is local implementation.

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
