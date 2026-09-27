# Engine multi-consumer handoff baseline

Status: source-level prepared; live schema activation intentionally deferred.

## Decision

Engine task state is the durable owner of repository work. Chat sessions, Claude
sessions, CLI runs, API clients, and future consumers are temporary execution or
review surfaces attached to that task state.

The task owns:

- repository identity and workspace path;
- initial Git/worktree baseline;
- current phase and cycle progress;
- execution authorization and mutation policy;
- latest deterministic/gateway decision;
- completion and cleanup signals;
- durable consumer bindings.

A conversation does not own the work. A conversation is represented as one
consumer binding among others.

## Consumer bindings

Consumer attachment is represented by `consumer_bindings[]` on the engine task.
The first canonical consumer is ChatGPT through the browser transport:

```json
{
  "consumer": "chatgpt",
  "transport": "browser"
}
```

Future consumers, such as Claude via remote MCP, CLI, or API clients, should add
their own binding records without replacing the ChatGPT binding.

The source-level attach point is:

```text
console.write.engine.consumer.bind
```

This endpoint is browser-neutral and does not open a browser or submit prompts.

## Compact handoff

The source-level compact resume point is:

```text
console.read_.engine.task.handoff
```

It returns `cmcp-engine-task-handoff-v1`, which is intentionally smaller than
`console.read_.engine.task.status`. It includes:

- task identity;
- baseline hashes;
- progress fields;
- decision fields;
- blocker fields;
- completion fields;
- consumer bindings;
