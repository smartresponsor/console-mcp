# Decision Action Contract

This document describes an optional structured action language for product-loop conversations and the decision engine.

It is not intended to constrain the target model to a rigid step sequence. It gives the loop a machine-readable way to recognize when the model wants repository actions executed.

## Purpose

The target ChatGPT conversation may answer naturally, call available MCP tools directly, or return a structured action request.

The decision engine may use structured action requests to execute safe local actions and feed the result back into the same chat.

## Action request shape

Preferred shape:

```json
{
  "status": "ACTION_REQUESTED",
  "action": "repo.patch.apply",
  "workspacePath": "D:\\PhpstormProjects\\www\\cataloging",
  "reason": "...",
  "arguments": {}
}
```

The action name is an intent, not necessarily the exact MCP tool name. The decision engine maps allowed intents to current tool capabilities.

## Common action intents

```text
repo.status.inspect
repo.diff.inspect
repo.file.read
repo.text.search
repo.patch.apply
repo.file.replace
repo.check.run
repo.commit.signed
package.check.run
framework.check.run
runtime.status.inspect
github.workflow.inspect
done
```

The list is intentionally small and capability-oriented. It may be extended without changing the core browser loop.

## Safe action expectations

Action requests should include enough information for the decision engine to validate scope and safety.

Patch and replacement requests should identify the workspace, files, reason, and intended change.

Commit requests should assume that the decision engine will inspect status and diff before committing.

## Decision engine responsibility

The decision engine is responsible for mapping requested actions to allowed tools, enforcing workspace scope, preserving user work, rejecting recursive orchestration, and feeding execution results back into the chat.

The engine may decline or reframe an action request when it is outside scope, unsafe, ambiguous, or unsupported by current tools.

Declining an action request does not mean the conversation failed. It is normal loop feedback.

## Recursive orchestration exclusion

Requests to call `console.write.browser.session.cmcp.go` from inside the target conversation must be rejected.

The correct response is to tell the target conversation that it is already inside the outer product loop and should use repository/tool capabilities directly.

## Feedback shape

When the decision engine executes or rejects an action, the next message to the target conversation should summarize the result compactly:

```json
{
  "status": "ACTION_RESULT",
  "action": "repo.patch.apply",
  "ok": true,
  "summary": "...",
  "toolResults": [],
  "filesChanged": [],
  "checksRun": [],
  "commit": null,
  "nextActionHint": "continue"
}
```

The feedback is context for the target model. It is not a script that forces a fixed next step.

## Completion shape

When the model believes the current loop objective is complete, it may report:

```json
{
  "status": "DONE",
  "summary": "...",
  "actionsTaken": [],
  "filesChanged": [],
  "checksRun": [],
  "commit": null,
  "risks": [],
  "nextAction": "..."
}
```

The decision engine decides whether to stop based on budget, completion signal, and repository state.
