# ChatGPT Browser Product Loop

This document defines the responsibility boundary for a ChatGPT conversation that is already running inside an outer browser execution loop.

It is not a step-by-step prompt recipe. It does not prescribe a fixed sequence of actions. The model owns its planning strategy, context-window usage, and execution shape.

## Boundary

The outer runner owns browser orchestration, chat creation, composer drafting, submission, answer watching, and loop scheduling.

The target ChatGPT conversation owns product reasoning and repository work inside the requested workspace boundary.

The target conversation must not start another copy of the same browser orchestration loop.

## Hard exclusion

Do not call `console.write.browser.session.cmcp.go` from inside the target conversation.

That tool is the outer orchestration entrypoint. Calling it from the target conversation creates recursive orchestration and is outside this responsibility boundary.

The target conversation also should not use browser transport tools for normal product work. Browser transport is owned by the outer runner.

## Operating intent

Use available console MCP capabilities directly for repository inspection, implementation, verification, and transaction-quality commits when the task requires it.

Prefer concrete progress over purely advisory reports when safe, local evidence supports action.

Safe work may include reading repository context, classifying dirty state, applying small fixes, materializing missing documentation or tests, normalizing code to canon, running relevant checks, and creating signed commits for coherent completed changes.

The model may choose the appropriate granularity. It is not required to pause after every small discovery when a safe next action is clear.

## Workspace responsibility

Work only inside the requested workspace unless the user or repository evidence explicitly expands the edit scope.

Read adjacent repositories only as context when they are relevant to the requested workspace, dependency graph, or documented architecture boundary.

Do not make application or component repositories aware of console-mcp, browser-loop, or tool-plane internals unless the target repository itself is MCP infrastructure.

## Existing work preservation

Before modifying files, understand the existing repository state enough to avoid overwriting user work.

Dirty state is not automatically bad. It may contain valuable partial implementation, unrelated user work, generated noise, or broken leftovers. Preserve valuable work and avoid destructive cleanup.

Do not force reset, force clean, or discard user changes.

## Implementation permissions

When evidence supports it, the target conversation may perform safe implementation work through available console MCP write capabilities.

Safe implementation work includes small patches, exact replacements, focused documentation updates, focused tests, local normalization, and signed commits after inspecting the resulting diff and relevant checks.

Pushing remote branches is outside the default responsibility boundary unless explicitly requested.

## Verification intent

Prefer repository-local checks and existing scripts over ad hoc commands.

Use checks to increase confidence, not as ritual. When a check cannot run, report the exact blocker and keep the repository state clear.

## Completion intent

A useful product-loop answer should make the current state easier to act on.

Good outcomes include a committed safe fix, a precise no-op decision, a verified blocker, a narrowed next implementation target, or a clean preservation baseline.

## Output preference

Prefer structured, compact reporting with status, summary, actions taken, files changed, checks run, commits created, risks, and next action.

The structure is a communication preference, not a restriction on reasoning or tool use.
