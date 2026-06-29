# Console MCP Tool Risk Model

`console-mcp` tools must be classified by visible risk, mutation surface, and required guardrails.

The public name must expose the risk class as the second token:

```text
console.read_.<domain>.<technology>.<subject>.<action>
console.write.<domain>.<technology>.<subject>.<action>
```

## Risk classes

### `read_`

Use `read_` for tools that inspect state without changing repository files, runtime processes, browser state, database state, package artifacts, or Git history.

Examples:

```text
console.read_.repo.git.diff
console.read_.repo.file.read
console.read_.database.sql.postgres.query
console.read_.browser.edge.session.status
console.read_.ai.gateway.ask
```

### `write`

Use `write` for tools that can mutate filesystem, Git, runtime, package artifacts, database state, browser/session state, external services, or release state.

Examples:

```text
console.write.repo.patch.apply
console.write.repo.git.commit.signed
console.write.package.composer.install
console.write.package.npm.build
console.write.runtime.php.server.restart
console.write.browser.edge.page.open
console.write.release.rc.repair
```

## Mutation flags

Every catalog entry must eventually include these machine-readable flags:

```json
{
  "mutatesFilesystem": false,
  "mutatesRuntime": false,
  "mutatesGit": false,
  "mutatesDatabase": false,
  "mutatesBrowser": false,
  "requiresBranchGuard": false,
  "requiresRuntimeBudget": false,
  "requiresEvidence": false
}
```

## Mixed-risk tools

Mixed-risk tools must be treated as legacy compatibility surfaces until they are split.

Examples:

```text
console.local_php_server
console.mobile_edge_server
console.composer
console.npm_script
console.rc
```

These tools may contain read-only actions and write-capable actions in one public name. The catalog must mark them as mixed and describe future canonical aliases.

## Guardrail rules

Write-capable repository tools must enforce or expose:

```text
branch-per-scope
no master/main write
expected changed files
diff size limits
forbidden generated/vendor/var/build/dist paths unless explicitly allowed
dry-run before apply where possible
