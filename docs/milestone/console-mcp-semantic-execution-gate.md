# console-mcp Semantic Execution Gate

Status: W0 contract baseline

## Responsibility

console-mcp remains the local execution plane. It must not become the final
governance authority. Its responsibility is to enforce an approved execution
ticket before write-capable tools run and to report the actual effect after the
operation.

## Tool classes

Read-only tools may run without an execution ticket:

- read_.system.console.describe
- read_.system.console.health
- read_.repo.workspace.status
- read_.repo.context.capture
- read_.repo.file.read
- read_.repo.text.search
- read_.repo.git.diff
- read_.repo.git.diff.stat
- read_.repo.git.grep
- read_.repo.git.file.show
- read_.http.loopback.request
- read_.http.loopback.curl
- read-only database query tools

Write-capable or state-capable tools require an execution ticket:

- write.repo.patch.apply
- write.repo.git.commit.signed
- write.framework.symfony.var.prune
- write.framework.symfony.cache.clear
- write.runtime.php.server.restart
- write.runtime.mobile_edge.server.restart
- write.package.composer.install
- write.package.npm.restart

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
