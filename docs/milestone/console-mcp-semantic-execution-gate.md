# console-mcp Semantic Execution Gate

Status: W0 contract baseline

## Responsibility

console-mcp remains the local execution plane. It must not become the final
governance authority. Its responsibility is to enforce an approved execution
ticket before write-capable tools run and to report the actual effect after the
operation.

## Tool classes

Read-only tools may run without an execution ticket:

- console.describe
- console.health
- console.workspace_status
- console.capture_context
- console.read_file
- console.search_text
- console.git_diff
- console.git_diff_stat
- console.git_grep
- console.git_show_file
- console.local_http
- console.local_curl
- read-only database query tools

Write-capable or state-capable tools require an execution ticket:

- console.apply_patch
- console.git_commit
- console.var_prune
- console.cache_clear
- console.local_php_server start, stop, or restart
- console.mobile_edge_server start, stop, or restart
- console.composer install, update, or dump-autoload
- console.npm_script when the selected script writes build, runtime, or evidence files

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
