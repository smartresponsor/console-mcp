# Stage 3B — Full immutable artifact attestation and storage identity

Status: **FULL LEGACY HASH ATTESTATION PASSED; CANONICAL MIGRATION NOT ADMITTED.**

## Live evidence (2026-11-02)

Read-only full-inventory verifier: `/usr/bin/python3 -I ops/ubuntu/deployment/release-store-full-attestation.py`.

| Role | Exact identity | Verified members | Manifest SHA-256 |
| --- | --- | ---: | --- |
| Active | `a6909e7b117340755717877f5d73ce8be3ab91ea` | 4514 | `2cdda1a2f4cb776945ec5d07878306afdbf6062747341638421147292ee92b8c` |
| Rollback | `6e0ac15c52a8153cc625252976fad59b6087985f` | 4513 | `1abd7cc713a55b5ef8443090dc62fb4e3eed727da7af3af88160ada6f0233a94` |

Both manifests report build fingerprint `98c72365561a666a`; the systemd active bind mount matches registry; MainPID `47820`. The verifier checks the full file inventory, SHA-256, root ownership, link targets and immutable member modes. Symlink mode bits are excluded from writable-file checks as in the existing production verifier, while link ownership and nonescaping targets remain enforced. No modifications to the protected artifacts.

## Storage identity problem

The requested user-facing name is `/home/alex/smartresponse/mcp/.releases`, adjacent to `.worktrees`. Its ancestors are user-owned/writable; an unprivileged operator can potentially replace the pathname or rename an ancestor. A root-owned `.releases` directory alone is therefore **not** an acceptable independently authenticated release root. Do not change ownership of the user's entire home or weaken the current fail-closed storage selector.

**Candidate design for separately reviewed implementation:** keep authoritative sealed bytes under a genuinely protected root-owned filesystem and expose a root-managed bind-mounted `.releases` view only after proving the runtime is pinned to a verified mount identity (mount ID, source device/inode and mount namespace), and that operators cannot rename ancestor path components during activation. Because `/home/alex` itself is user-controlled, binding alone is not an adequate proof. If this cannot be proven, prioritize the immutable security boundary and treat `.releases` as an indexed view instead of a production authority. The canonical logical release-store contract remains, but its physical security design is **undecided**, and the Stage 2 allowlist remains deliberately fail-closed.

## Next security gates

1. Independently authorize physical storage identity and root-owned mount policy; prove safe behavior under ancestor rename/replacement attempts, service account access and mount-namespace changes.
2. Re-attest full source and destination inventories byte-for-byte before any registry change.
3. Validate replacement controller scripts and policy as one atomic root-owned generation, with exact rollback environment.
4. Perform sandbox start and rollback tests against the new storage identity.
5. Only then permit protected transactional cutover. Retain all legacy originals pending explicit retention approval.
