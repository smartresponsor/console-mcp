# Console MCP Tool Naming Canon

This document is the naming source of truth for the next `console-mcp` standardization track.

The project goal is not generic computer access. The goal is a controlled AI runtime for engineering work with explicit risk, domain, technology, evidence, branch, diff, and restart boundaries.

## Root namespace

The public MCP root namespace is fixed:

```text
console
```

Do not use `SmartResponse`, `SmartResponsor`, `app`, `agent`, or `runtime` as the MCP public root namespace.

`SmartResponsor` may remain in DNS, hostname, Auth0 audience, or deployment identity, for example `console-mcp.smartresponsor.com`. That is infrastructure identity, not public MCP tool naming.

## Public tool name form

Future public canonical names must follow this shape:

```text
console.<risk>.<domain>.<technology>.<subject>.<action>
```

The second token must expose the risk class immediately.

Allowed risk tokens are:

```text
read_
write
```

`read_` uses underscore padding so both risk tokens are five characters wide. Do not use `read`, `read-`, `reado`, `ro`, `rw`, or other variants.

## Canonical examples

```text
console.read_.system.console.describe
console.read_.system.console.health
console.read_.system.console.tool.catalog

console.read_.repo.workspace.status
console.read_.repo.context.capture
console.read_.repo.file.read
console.read_.repo.text.search
console.read_.repo.git.diff
console.read_.repo.git.diff.stat
console.read_.repo.git.branch.status
console.read_.repo.git.remote.summary
console.read_.repo.git.sync.plan
console.read_.repo.git.grep
console.read_.repo.git.file.log
console.read_.repo.git.file.show
console.read_.repo.git.reflog.search
console.write.repo.file.replace.text
console.write.repo.patch.apply
console.write.repo.git.commit.signed
console.write.repo.git.fetch
console.write.repo.git.pull.ff.only
console.write.repo.git.branch.create
console.write.repo.git.push.current
console.write.repo.git.push.current.set.upstream

console.read_.package.composer.validate
console.read_.package.composer.show
console.read_.package.composer.audit
console.read_.package.composer.outdated
console.write.package.composer.install
console.write.package.composer.update
console.write.package.composer.dump.autoload

console.read_.package.npm.typecheck
console.read_.package.npm.test
console.read_.package.npm.smoke
console.write.package.npm.build
console.write.package.npm.restart

console.read_.framework.symfony.route.list
console.read_.framework.symfony.container.diagnostics
console.write.framework.symfony.cache.clear

console.read_.framework.doctrine.migration.status
console.write.framework.doctrine.migration.migrate

console.read_.database.sql.postgres.query
console.read_.database.sql.mysql.query
console.read_.database.sql.sqlite.query

console.read_.runtime.php.server.status
console.write.runtime.php.server.restart
console.read_.runtime.console_mcp.server.status
console.write.runtime.console_mcp.server.restart

console.read_.browser.edge.session.status
console.write.browser.edge.page.open
console.read_.ai.gateway.ask
console.read_.release.rc.diagnose
console.write.release.rc.repair
```
