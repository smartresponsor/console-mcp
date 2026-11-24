# Repository writable execution: isolation contract

Status: design only; not enabled in production.

## Observed failure

Console MCP has an immutable release bind-mounted read-only over
/home/alex/smartresponse/mcp/console-mcp/src. ReadWritePaths cannot override
that mount. The file replacement tool runs in the Console MCP process.
Forked repository workers inherit its mount namespace.

## Required boundary

1. Keep immutable release mounts read-only.
2. Run mutations in a separately managed non-root service with a writable
   view of /home/alex/smartresponse, not a fork of Console MCP.
3. Reuse the authenticated Repo Facade as entry point; no public TCP listener.
4. Restrict Unix socket access and independently authorize each operation
   and canonical repository scope inside the worker.
5. Preserve path guards, symlink checks, denied paths, admission, audit,
   transcripts, and operation-specific validations.
6. Use bounded messages, request IDs and fail-closed timeouts. Never
   automatically retry a mutation with uncertain outcome.
7. Do not modify or reset the dirty canonical workspace during preparation.

## Required acceptance

- Runtime release src remains read-only.
- Worker canonical src and isolated worktrees are writable.
- Public file mutation on canonical src preserves SHA-256 and Git status.
- Unauthorized paths, symlink escapes and malformed IPC fail closed.
- Worker restart, crash, timeout and socket permissions tested.
- TypeScript, repository-isolation, Repo Facade and security tests pass.
- Deployment and rollback both have verified live smoke tests.

This plan is not an implementation or authorization to relax hardening.
Implementation must reconcile existing uncommitted development first.
