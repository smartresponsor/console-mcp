# ChatGPT Artifact Guard

## Purpose

ChatGPT Artifact Guard is a pre-execution semantic review layer for ChatGPT Web UI work.

It reviews assistant-produced artifacts before the user sends `Go`, `Next`, `Do it`, or an equivalent execution approval. It does not replace post-execution gates. It prevents non-canonical plans, reports, commands, naming, or tree recommendations from reaching the execution phase.

## Responsibility split

```text
Canonizing = source of truth for canonical rules.
Artifact Guard = pre-execution review of assistant output.
RC/Gate = post-execution validation of repository facts.
```

The guard must not invent canon. It must load or reference Canonizing rules and repo context when performing semantic review.

## User responsibility

The user is responsible for opening ChatGPT only in the supervised Playwright browser.

The user is not responsible for manually providing a chat id. Chat binding is a browser/MCP responsibility.

## Bootstrap contract

Session bootstrap only binds the browser page and chat identity.

It must not inject an agent protocol by default.
It must not inject a task prompt by default.
It must not guard user-originated prompts.

Bootstrap records:

```text
provider = chatgpt-web
chatId = extracted from the browser URL
page binding = supervised Playwright tab/page identity
baseline assistant artifact hash = latest assistant message at bind time, if any
```

## Chat identity

The primary chat identity source is the ChatGPT Web URL observed by Playwright.

Expected URL shape is `/c/<chatId>`. Additional URL shapes may be added through explicit parser support. Internal ChatGPT messages must not be trusted to report their own chat id.

## Cursor contract

The guard does not rely on message numbers.

It relies on:

```text
chatId
page binding
message role
message hash
baseline assistant hash
last guarded assistant hash
```

User-originated messages are never guard artifacts, even if they are injected by MCP, Ask, another agent, or Playwright automation.

The first user prompt in a newly bound chat is skipped. Guard capture starts with the first assistant response after that prompt.

If multiple user prompts are sent before the assistant answers, the cursor does not break. The next new assistant message after baseline is the first guardable artifact.

For an already open chat, the current latest assistant artifact is recorded as baseline. Historical assistant artifacts are not guarded. Only future assistant artifacts are eligible.

## Guardable artifact

A guardable artifact is a new assistant message that:

```text
belongs to the bound chatId
is role=assistant
appears after the baseline cursor
has not been guarded before
```

It may contain an analysis, report, plan, command suggestion, naming recommendation, architectural recommendation, or execution intention.

## Injection safety

Before any corrective comment or approval phrase is written back into ChatGPT Web UI, the browser layer must revalidate:

```text
currentChatId == expectedChatId
current latest assistant hash == transaction assistant hash
bound Playwright page is still alive
prompt field is available
```

If any check fails, injection is blocked and the transaction is marked stale.

Default injection policy is draft-only. Auto-submit requires a separate explicit policy and must still pass the revalidation checks.

