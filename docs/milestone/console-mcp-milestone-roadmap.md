# console-mcp Milestone Roadmap

Status: planning baseline  
Repository: `console-mcp`  
Primary responsibility: controlled local workspace/runtime tool plane

## 1. Purpose

console-mcp is the controlled local tool plane for SmartResponsor engineering work.

It exposes safe inspection, diagnostics, and guarded patch application. It must not become the model router, the browser operator, the policy authority, or the memory authority.

## 2. Current authority boundary

Mutation authority is limited to:

```text
console.apply_patch
```

The expected write sequence is:

```text
analyze -> propose patch -> user approval -> dry run -> apply -> evidence -> checks
```

## 3. M0: Execution contract freeze

Outcome:

- keep `console.apply_patch` as the only mutation tool;
- require dry-run before final apply;
- keep arbitrary command execution unavailable;
- keep workspace-root and path safety checks.

Exit criteria:

- docs and tool descriptions agree on mutation authority;
- no new write tool is introduced without policy review.

## 4. M1: Boundary-aware write reports

Outcome:

- every proposed write cites the component boundary;
- every write result cites changed paths;
- every write report cites expected evidence.

Exit criteria:

- Boundarying can validate whether changed paths are in scope;
- Gating-mcp can validate whether review evidence is present.

## 5. M2: Adjudication-aware execution context

Outcome:

- execution plans can reference an Adjudication runtime pack;
- hard prohibitions can block unsafe write proposals;
- audit tokens can be included in final reports.

Exit criteria:

- console-mcp does not decide canon;
- console-mcp can carry Adjudication context as evidence.

## 6. M3: Symfony runtime inspection maturity

Outcome:

- improve Symfony diagnostics around cache, route, service, migration, test, and local server status;
- keep diagnostics read-only unless they are explicitly allowlisted maintenance commands;
- capture evidence without leaking secrets.

Exit criteria:

- local Symfony diagnostics are reliable enough to support AI review;
- write authority remains narrow.

## 7. M4: Codex and ChatGPT profile stability

Outcome:

- keep ChatGPT OAuth and Codex bearer profiles separated;
- keep local endpoints stable;
- keep Cloudflare tunnel config documented;
- keep token values outside Git.

Exit criteria:

- smoke checks can verify local ChatGPT, local Codex, and public endpoint behavior;
- reconnect instructions exist when scopes change.

## 8. M5: Evidence capture and handoff

Outcome:

- standardize final evidence fields;
- include diff stat, checks, and tool-call summary;
- pass evidence into Adjudication and Gating where needed.

Exit criteria:

- every AI-assisted write can be reconstructed from evidence;
- final reports distinguish analysis, dry-run, write, and validation.

## 9. Guardrails

- console-mcp must not print full process environments.
- console-mcp must redact bearer tokens, OAuth tokens, client secrets, refresh tokens, authorization codes, passwords, cookies, and private keys.
- console-mcp must keep mutation tools explicit, narrow, and evidence-producing.
- console-mcp must not become a persistent memory store.
- console-mcp must not decide platform canon; it can only carry canon evidence from owning components.
- console-mcp must not store real secrets in examples, fixtures, docs, transcripts, or generated reports.

## 10. M6: Vaulting runtime boundary

Outcome:

- keep sensitive runtime values declared by reference only;
- use Vaulting for child-process runtime delivery;
- keep `CONSOLE_MCP_BEARER_TOKEN` and `CLOUDFLARE_API_TOKEN` out of repository files, prompts, transcripts, and logs.

Exit criteria:

- `config/secret/secret.required.json` declares required sensitive values by reference;
- `config/secret/secret.map.example.json` contains references only;
- local smoke can run through Vaulting without printing resolved values.

## 11. Current next actions

1. Keep the Vaulting declarations synchronized with runtime code.
2. Add a safe smoke path for Vaulting-backed local Codex bearer startup.
3. Add report fields that distinguish user-approved writes from read-only diagnostics.
4. Keep ChatGPT OAuth and Codex bearer profile docs separate.
