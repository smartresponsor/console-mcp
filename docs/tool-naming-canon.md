# Console MCP Tool Naming Canon

This document is the naming source of truth for the next `console-mcp` standardization track.

The project goal is not generic computer access. The goal is a controlled AI runtime for engineering work with explicit risk, domain, technology, evidence, branch, diff, and restart boundaries.

## Provider And Capability Identity

The MCP provider identity is fixed by the server name:

```text
console-mcp
```

Public capability identifiers must not repeat that provider identity. There is no public capability root token named `console`.

Do not use `console`, `SmartResponse`, `SmartResponsor`, `app`, `agent`, or `runtime` as a public capability root namespace.

`SmartResponsor` may remain in DNS, hostname, Auth0 audience, or deployment identity, for example `console-mcp.smartresponsor.com`. That is infrastructure identity, not public MCP tool naming.

## Public tool name form

Future public canonical names must follow this shape:

```text
<risk>.<domain>.<technology>.<subject>.<action>
```

The first token must expose the risk class immediately.

Allowed risk tokens are:

```text
read_
write
```

`read_` uses underscore padding so both risk tokens are five characters wide. Do not use `read`, `read-`, `reado`, `ro`, `rw`, or other variants.

## Web And Browser Domains

Public capability domains describe semantics, not provider provenance.

- `web.*` covers interaction with external web surfaces.
- `web.browser.*` is used when the browser runtime/resource itself is the subject.
- `browser.*` remains the Console-owned supervised browser/ChatGPT runtime and orchestration domain.
- The backing provider may remain `network-mcp`; that ownership belongs in metadata, not in the public capability name.

Examples:

```text
read_.web.browser.status
write.web.browser.open
read_.web.page.capture
write.web.page.click
read_.web.form.inspect
write.web.form.fill
write.web.form.submit
```
## Canonical examples

```text
read_.system.console.describe
read_.system.console.health
read_.system.console.tool.catalog

read_.repo.workspace.status
read_.repo.context.capture
read_.repo.file.read
read_.repo.text.search
read_.repo.git.diff
read_.repo.git.diff.stat
read_.repo.git.branch.status
read_.repo.git.remote.summary
read_.repo.git.sync.plan
read_.repo.git.grep
read_.repo.git.file.log
read_.repo.git.file.show
read_.repo.git.reflog.search
write.repo.file.replace.text
write.repo.patch.apply
write.repo.git.commit.signed
write.repo.git.fetch
write.repo.git.pull.ff.only
write.repo.git.branch.create
write.repo.git.branch.switch
write.repo.git.push.current
write.repo.git.push.current.set.upstream

read_.package.composer.validate
read_.package.composer.show
read_.package.composer.audit
read_.package.composer.outdated
write.package.composer.install
write.package.composer.update
write.package.composer.dump.autoload

read_.package.npm.typecheck
read_.package.npm.test
read_.package.npm.smoke
write.package.npm.build
write.package.npm.restart

read_.framework.symfony.route.list
read_.framework.symfony.container.diagnostics
write.framework.symfony.cache.clear

read_.framework.doctrine.migration.status
write.framework.doctrine.migration.migrate

read_.database.sql.postgres.query
read_.database.sql.postgres.diagnostics
read_.database.sql.mysql.query
read_.database.sql.mysql.diagnostics
read_.database.sql.sqlite.query
read_.database.sql.sqlite.diagnostics

read_.runtime.php.server.status
write.runtime.php.server.restart
read_.runtime.console_mcp.server.status
write.runtime.console_mcp.server.restart

read_.browser.edge.session.status
write.browser.edge.page.open
read_.ai.gateway.ask
read_.release.rc.diagnose
write.release.rc.repair
```
