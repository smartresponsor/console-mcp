# console-mcp Semantic Execution Gate

Status: W0 contract baseline

## Responsibility

console-mcp remains the local execution plane. It must not become the final
governance authority. Its responsibility is to enforce an approved execution
ticket before write-capable tools run and to report the actual effect after the
operation.

## Tool classes

Read-only tools may run without an execution ticket:

- console.read_.system.console.describe
- console.read_.system.console.health
- console.read_.repo.workspace.status
- console.read_.repo.context.capture
- console.read_.repo.file.read
- console.read_.repo.text.search
- console.read_.repo.git.diff
- console.read_.repo.git.diff.stat
- console.read_.repo.git.grep
- console.read_.repo.git.file.show
- console.read_.http.loopback.request
- console.read_.http.loopback.curl
- read-only database query tools

Write-capable or state-capable tools require an execution ticket:

- console.write.repo.patch.apply
- console.write.repo.git.commit.signed
- console.write.framework.symfony.var.prune
- console.write.framework.symfony.cache.clear
- console.write.runtime.php.server.restart
- console.write.runtime.mobile_edge.server.restart
- console.write.package.composer.install
- console.write.package.npm.restart

## Future guard

Every guarded tool must compare the current call with the approved ticket:

- tool name is approved;
- effect class is approved;
- workspace and repository match;
- changed paths stay inside approved paths;
- denied effects are absent;
- ticket is not expired or revoked.

## Post-effect report

After a write-capable operation, console-mcp should collect:

- changed files;
- removed files;
- diff stat;
- validation command results;
- whether the effect matched the approved ticket.

The post-effect report is sent to Adjudicating for final audit and decision.
