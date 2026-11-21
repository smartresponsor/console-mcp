# P0 SmartResponse workspace root canonicalization

## Incident and root cause

On 2026-11-20 the live Repo Facade rejected
`read_.repo.git.worktree.list({workspacePath: "/home/alex/smartresponse/mcp/looping/browsing"})`
with `Path is outside the allowed roots`. Correlation ID:
`unscoped-e1ca09ce-81af-4481-99bf-9fa3d8856063`.

The production process was `/usr/bin/node .../net282-repo-facade/dist/engine/repo-standalone-runtime.js`
(PID 247648), sourced from detached commit `abe0c699063b444b6cdf7830e15c95cfb413baac`.
`repo-mcp.service` set `NET282_POLICY_ROOT` to that staging worktree but set neither
`CONSOLE_MCP_WORKSPACE_ROOT` nor `CONSOLE_MCP_EXTRA_ALLOWED_ROOTS`. The shared policy file
contained only the existing Windows root. `loadConsolePolicy` consequently added the runtime's
own policy/worktree root but not the Ubuntu SmartResponse workspace root.

The facade did not own a different Git engine: its handler ultimately called the shared Console
MCP `registerGitWorktreeTools` -> `listGitWorktrees` -> `assertAllowedRoot` -> supervised
`git worktree list --porcelain`. The inconsistency was caused by deployment provenance and an
incomplete cross-platform root policy, not by repository state.

Two defense-in-depth defects were also confirmed in the shared guard:

- containment was case-insensitive on Linux because all paths were converted to lower-case;
- authorization was lexical, so an in-root symlink could resolve outside the workspace.

The primary Console checkout and Browsing checkout were dirty before this work and were not
modified, switched, reset, cleaned, or added to `safe.directory`.

## AS-IS / TO-BE architecture

AS-IS:

`Repo facade route -> Console tool handler -> shared PathGuard -> Git`, but the facade service
loaded a Windows-only policy with no Ubuntu workspace environment. A detached dirty worktree also
contained uncommitted standalone runtime/deployment code, making production provenance incomplete.

TO-BE:

`Repo facade route -> canonical Console tool handler -> platform-selected ConsolePolicy ->
canonical PathGuard -> operation-specific repository/permission/confirmation checks -> Git`.

`policy/allowed-root.json` now records the Ubuntu workspace boundary separately from the preserved
Windows default. Facades do not implement path authorization. `PathGuard` canonicalizes an existing
path, or its nearest existing ancestor for a not-yet-created path, before component-aware
containment. Windows drive/UNC paths remain case-insensitive; POSIX paths remain case-sensitive.

The workspace boundary is not a write grant. Existing denied-path, OAuth read/write scope,
confirmation, repository validity, ownership, filesystem permission, dirty-worktree, branch, exact
SHA, and operation-specific checks remain in force. No `safe.directory` entry is added.

## Validator and configuration inventory

- Canonical policy loader: `src/Policy/ConsolePolicy.ts`.
- Canonical path guard used across repository/file/test/archive operations:
  `src/Policy/PathGuard.ts`.
- Repository scope/registry checks: `src/service/repository-registry.ts` and
  `src/tool/workspace-scope.ts`.
- Worktree implementation: `src/tool/git-worktree.ts`.
- Other Git operations: `src/tool/git-inspection.ts`, `src/tool/git-repo-peer.ts`, and reviewed
  merge/push/archive handlers registered by Console MCP.
- File and bounded-write enforcement: `src/Infrastructure/FileSystem/SafeFileSystem.ts` and
  `src/Infrastructure/FileSystem/FileEdit.ts`.
- Ubuntu source of truth: `ops/ubuntu/config/console-mcp.env.example` and
  `ops/ubuntu/script/install-systemd.sh` already specify/derive `/home/alex/smartresponse`.
- Windows source of truth: the existing `defaultRoot` remains unchanged; no Windows path was
  invented by this change.
- Conflicting live configuration: `/etc/systemd/system/repo-mcp.service` (readable through systemd
  properties but not directly by the current user) omitted the canonical Console workspace root.
- Duplicate executable code: the live `repo-standalone-runtime.js` source exists only as untracked
  files in the detached NET282 worktree. It must not be promoted as an independent execution engine;
  deployment should use the committed Console facade route.

The Console repository currently registers 159 linked worktrees. Browsing has ten registered
worktrees. The canonical workspace contains many independent and nested Git repositories; workspace
membership alone does not classify a directory as a repository.

## Verification evidence

- Before: live Repo Facade reproduced the exact rejection above.
- After (isolated build): the Repo MCP HTTP facade executed
  `read_.repo.git.worktree.list` for `/home/alex/smartresponse/mcp/looping/browsing` successfully.
- `npm run typecheck`: pass.
- `npm run build`: pass.
- `node tool/workspace-root-policy-regression.mjs`: pass.
- `CONSOLE_MCP_TEST_REPO_WORKSPACE=/home/alex/smartresponse/mcp/looping/browsing node tool/mcp-facade-http-regression.mjs repo`: pass (69 tools, OAuth and cross-consumer denial verified).
- `npm run test:ubuntu-workspace`: pass.
- `npm run test:repo-facade`: pre-existing wrapper failure: `tool/repo-facade-regression.mjs`
  expects `CHATGPT_FACADE_GROUPS = ["repo"]`, while current master contains Repo, Runtime, and
  Browser. The HTTP Repo facade regression itself passes.

The adversarial regression covers deep and sibling paths, a non-existent descendant, `..`, prefix
collision, NUL input, symlink escape, POSIX case sensitivity, and Windows drive casing/separators.
Git fail-closed coverage exercises invalid repositories, dirty state, unsafe ownership, missing Git,
and guarded sync/push behavior. Mutation authorization and filesystem permissions remain separate
from workspace containment.

## Deployment and rollback

Deployment is a separate, privileged milestone and is not performed by this change.

1. Merge the reviewed commit and build a sealed Console MCP release from that exact SHA.
2. Replace the detached NET282 runtime with the committed canonical Console facade deployment.
3. Ensure the Repo service inherits `CONSOLE_MCP_WORKSPACE_ROOT=/home/alex/smartresponse` from the
   canonical environment source; do not add per-repository `safe.directory` entries automatically.
4. Validate unit provenance, effective environment, service user/group, ACL traversal, and release
   hashes before restart.
5. Restart only `repo-mcp.service` during an approved maintenance window.
6. Execute the original facade call, an outside-root denial, a symlink-escape denial, and a
   read/write-scope denial against the deployed endpoint.

Rollback: restore the preceding sealed service artifact and unit/environment snapshot, daemon-reload
if the unit changed, restart only Repo MCP, and repeat the denial checks. Do not roll back by widening
roots, disabling canonicalization, changing ownership, or adding Git trust entries.

## Remaining limitations

- Live production remains unfixed until an authorized release replaces the detached NET282 runtime.
- The current user cannot read the unit file directly; `systemctl show` supplied effective
  provenance. A privileged deploy reviewer must compare the file and environment secret source.
- JavaScript path checks cannot provide descriptor-relative `openat2` guarantees for every later Git
  subprocess. Canonical paths remove symlink aliases, and existing operation checks narrow the race;
  immutable/sealed deployment roots and filesystem ownership remain required for full TOCTOU defense.
