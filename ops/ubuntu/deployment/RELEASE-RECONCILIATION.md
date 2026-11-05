# Continuous production delivery: staged implementation

The release observer compares a locally fetched `origin/master` commit to a committed transaction's `sourceSHA`, cross-checking its candidate against the protected registry. A matching committed transaction is `REGISTERED_CURRENT`, **not** proof of live runtime identity. It is read-only. It does not fetch, seal, validate, change broker policy, activate, restart services, or override admission. The operator must not interpret its output as proof of the actual systemd runtime bind mount.

The observer is deliberately **not** a Watchdog lane: Watchdog checks running-service health. Release promotion belongs to the privileged deployment controller, with separate authorization.

The proposed timer and service are **not installed or enabled** by this change. The sample unit expects an independently reviewed, root-owned installation of the observer script under `/opt/console-mcp-deploy`. Never run a mutable repository script as root. The timer is observation only and must not be presented as automatic delivery.

## Trust-based promotion contract (proposed, NOT enabled)

The existing broker's `authorizedSha` is an exact-SHA allowlist. It must remain authoritative until a separately reviewed root-owned controller and policy version explicitly implement source-based authorization. **Do not interpret `preparationEligible` as permission to deploy.** The observer is advisory and uses the local tracking ref; that ref can be stale or influenced by a mutable checkout.

A future root-owned reconciler must enforce the following contract as a single serialized transaction:

1. **Canonical source:** fetch only the pinned repository URL and `refs/heads/master` into a root-controlled, isolated Git store; never trust a SHA, repository URL, worktree path, or approval claim supplied by an MCP caller. Pin and verify the expected remote identity, reject ambiguous refs and unexpected redirects, and record the fetched commit SHA.
2. **Provenance and branch policy:** verify the exact fetched commit and its signature against an explicit trusted signer set; independently establish the protected-branch policy and required review/check evidence at that commit. A valid signature alone is insufficient to prove the commit was admitted to protected master. Fail closed if branch protection, checks, identity or provenance cannot be established.
3. **Replay and concurrency:** acquire the root-owned broker lock before planning a promotion, re-read the current committed transaction and live runtime identity, and reject conflicting or incomplete transactions. Store durable receipts keyed by the exact target SHA and source-policy revision. Do not treat a previous failed or interrupted attempt as authorization to retry activation automatically.
4. **Immutable preparation:** create a clean isolated source snapshot, authenticate the sealed candidate and manifest, and execute only the installed trusted controllers through the broker. The source policy must authorize *the controller*, not grant the MCP service general `prepare` or `activate` privileges.
5. **Validation:** require all mandatory build, regression, security, admission, schema, release, and browser-continuity gates for the exact candidate. Preserve signed results and hashes in the transaction receipt. Reject stale evidence and any discrepancy between candidate, manifest, desired SHA and policy revision.
6. **Safe-window activation:** re-check live PID, runtime fingerprint, mount, rollback artifact, transaction and Edge/CDP continuity immediately before activation. An unsafe window must defer promotion, not forcibly restart the browser. The controller must execute a bounded activation and post-cutover verification, then commit only after the new live runtime identity is proven.
7. **Failure handling:** on failed activation or post-cutover checks, use the authenticated rollback controller and verify the restored live identity. Mark uncertain outcomes as `REVIEW_REQUIRED`; never loop endlessly or silently declare success. Revoke temporary authorization after the transaction.
8. **Audit:** write durable root-owned receipts for every decision: target SHA, policy revision, signer evidence, check results, candidate manifest, previous and new runtime identities, rollback identity, timings and terminal state. Keep secrets and browser authentication material out of receipts.

### Authority boundaries

- Observer / MCP service: read-only status, no policy writes, no privileged source selection, no activation.
- Root-owned reconciler: trusted source resolution, provenance checks, serialized promotion decision and durable receipts.
- Release Broker: sole executor of existing prepare/validate/activate/rollback operations; retain peer checks, immutable candidate verification and controller gates.
- Watchdog: independent runtime health supervision, never release promotion.
- Operator: explicit emergency override and review of uncertain states; no hidden authorization inferred from a successful build.

### Rollout sequence

1. Add hermetic tests for source substitution, stale refs, unsigned commits, signer mismatch, branch-protection evidence missing, concurrent runs, stale gates, rollback failure, and interrupted receipts.
2. Implement and test a versioned root-owned source-policy evaluator with no mutation privileges. It must fail closed on unknown policy versions and missing evidence.
3. Implement reconciler prepare-only dry runs and signed audit receipts; verify against the actual installed controller generation.
4. Enable controlled promotion in a staging environment with injected activation failures and verified rollback.
5. Independently verify production admission, browser continuity, and the deployed controller generation before enabling the timer. Activation remains disabled by default until approved.

Do not couple canonical `.releases` migration to the immediate production recovery. The Nov 4 one-time production promotion is a separate completed operation and does not authorize this proposed policy.
