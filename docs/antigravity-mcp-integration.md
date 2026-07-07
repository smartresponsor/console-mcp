# Antigravity MCP Integration

This runbook records the current local Antigravity CLI MCP setup for `console-mcp`, codebase memory, and GitHub MCP on this Windows machine.

## Canonical Workspace

Use this repository for all new work:

```powershell
D:\PhpstormProjects\www\mcp\console-mcp
```

Do not use this stale clone for new work:

```powershell
D:\PhpstormProjects\www\console-mcp
```

Antigravity has observed both clones. Treat `D:\PhpstormProjects\www\mcp\console-mcp` as canonical and `D:\PhpstormProjects\www\console-mcp` as non-canonical until it is manually reviewed and quarantined.

## Runtime

Observed Antigravity CLI:

- Command: `agy`
- Version: `1.0.16`
- Path: `C:\Users\Admin\AppData\Local\agy\bin\agy.exe`

Run Antigravity and Codex work from the canonical workspace:

```powershell
cd D:\PhpstormProjects\www\mcp\console-mcp
```

## MCP Config

Antigravity MCP config:

```powershell
C:\Users\Admin\.gemini\config\mcp_config.json
```

Expected MCP servers:

- `codebase-memory-mcp`
- `console-mcp-local-oauth`
- `github`

Preserve all configured MCP servers when editing this file. Back it up before modifying it.

## GitHub MCP

GitHub MCP is currently Docker-based.

The GitHub MCP server uses the Windows user environment variable:

```powershell
GITHUB_PERSONAL_ACCESS_TOKEN
```

Never write the token value into `mcp_config.json`, repo files, docs, command output, logs, or examples. Keep the config as an environment variable reference.

`gh` auth is already the preferred token source. The working path is:

1. GitHub CLI auth stores the credential in the local keyring.
2. `GITHUB_PERSONAL_ACCESS_TOKEN` is available in the Windows user environment.
3. Docker-based GitHub MCP receives only the environment variable name/reference.

## Smoke Commands

Check that the three expected MCP servers are visible:

```powershell
agy --print-timeout 3m --print "Check MCP availability only. List whether these MCP servers are visible: codebase-memory-mcp, console-mcp-local-oauth, github. Do not print env values or tokens."
```

Read-only end-to-end smoke:

```powershell
agy --print-timeout 5m --print "Use local git access, console MCP, codebase memory MCP, and GitHub MCP together. Read-only mode only. Detect the current repository, report local branch and git status, inspect the matching GitHub repository, list open PRs, latest workflow runs, latest release/tag, and compare local branch with remote default branch. Do not modify files, issues, PRs, branches, tags, workflows, releases, or settings."
```

## Known Result

The current observed setup:

- `github` MCP works.
- Antigravity found two `console-mcp` clones.
- Canonical clone: `D:\PhpstormProjects\www\mcp\console-mcp`
- Stale clone: `D:\PhpstormProjects\www\console-mcp`

If Antigravity reports both clones, select or run from the canonical path only.

## AWS Token Bootstrap Note

AWS Secrets Manager was considered for token bootstrap, but it is not the current operational path.

The current working path is:

```text
gh keyring -> GITHUB_PERSONAL_ACCESS_TOKEN -> GitHub MCP
```

Do not include secret values in AWS notes, MCP config, examples, or smoke output.

## Operational Rule

Always run Antigravity and Codex work from:

```powershell
D:\PhpstormProjects\www\mcp\console-mcp
```

The stale clone must remain unused for new work unless a future manual recovery pass explicitly extracts reviewed content from it.
