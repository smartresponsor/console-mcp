# Console MCP Root Prefix Removal

## Goal

Remove the redundant `console.` token from public Console MCP capability identifiers.

The MCP server already carries the provider identity `console-mcp`. Public tool names should therefore describe the capability itself rather than repeat the server identity.

## Canonical target

```text
read_.<domain>.<resource>.<action>
write.<domain>.<resource>.<action>
```

Examples:

```text
read_.repo.git.diff
write.repo.git.commit.signed
read_.web.form.inspect
write.web.form.fill
```

This milestone removes only the root token `console.`. The existing `read_` versus `write` risk-token convention is intentionally unchanged and can be addressed by a separate milestone.

## Architectural rule

Server identity and capability identity are separate concerns:

- server identity: `console-mcp`
- capability identity: `read_....` or `write....`

The provider name must not be duplicated inside every capability identifier.

## In scope

- runtime tool registrations;
- canonical catalog entries;
- admission and consumer-profile policy;
- tool-to-tool references such as `next_tool`, `executor_tool`, and plans;
- regression and smoke fixtures;
- current operational and architecture documentation;
- Console MCP agent instructions that name capabilities.

## Out of scope

Do not rename unrelated infrastructure identities that merely contain the word `console`, including:

- the `console-mcp` server/repository name;
- `tool/dev-console.ps1`;
- DNS or deployment identity;
- OAuth scopes such as `console:write`;
- JavaScript `console.log` and similar language APIs.

## Migration invariant

The migration is complete only when all of the following hold:

1. the live tool catalog contains no capability beginning with the retired `console.` plus `read_` or `write` prefix;
2. tracked runtime, policy, tests, and current docs contain no canonical capability reference using that retired prefix form;
3. registration/catalog/admission gates pass;
4. typecheck and regression gates pass;
5. the restarted Console MCP advertises the prefix-free names through `read_.system.console.describe`.

## Compatibility stance

No permanent alias layer is desired. Keeping both prefixed and prefix-free names would double the public surface and preserve the drift this milestone is intended to remove.

If a short migration bridge is proven necessary by a concrete consumer, it must be explicitly time-bounded and removed before milestone closure.

## Completion evidence

Completed on 2026-09-29.

- Residual scan: `rg -n 'console\.read_|console\.write\.' .` returned no matches.
- Broader stale-assumption scan: no validators, catalog metadata, or current docs require the old capability root. The only retained `console` root wording is negative canon text forbidding `console` as a capability root.
- Intentional preserved uses: OAuth scopes `console:read` and `console:write`; server/repository identity `console-mcp`; development entrypoint `tool/dev-console.ps1`; environment names such as `CONSOLE_MCP_*`; JavaScript `console.*`.
- Source of truth: `docs/tool-naming-canon.md`, `docs/security.md`, catalog fragments, admission projection, and registration validators all define capability identity as `read_.*` or `write.*`.
- Artifact guard: stale prefixed capability IDs are detected as retired names, while malformed roots such as `read.`, `write_.`, `mutate.`, and `run.` remain non-canonical.
- Gates executed: `npm run typecheck`, `npm run build`, `npm run schema:validate`, `npm run smoke`, and `npm run test` all passed.
- Runtime verification: local smoke and Console MCP regression advertised prefix-free names including `read_.system.console.describe`, `read_.repo.git.diff`, and `write.repo.git.commit.signed`; no `console.` capability aliases were advertised. The OAuth challenge still uses `scope="console:read"`.
- Compatibility: no permanent alias layer was introduced.
