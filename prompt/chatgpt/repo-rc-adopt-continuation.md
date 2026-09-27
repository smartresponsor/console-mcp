Original user request: {{rawPrompt}}

Resolved orchestration preset: repo_rc_adopt_continuation.

Workspace:
{{workspacePath}}

Target component:
{{componentName}}

Continuation expansion:
- This prompt was expanded by console-mcp for repeat adoption of an existing ChatGPT chat.
- Continue the bounded repository task in the already selected conversation.
- Preserve the previous useful progress and do not restart from scratch unless the current repository state proves it is necessary.

Git reconciliation and publication contract:
- Treat dirty/untracked state and local/remote divergence as state to classify and reconcile, not as an automatic terminal blocker.
- Before refusing a commit or push, inspect status, diffs, branch/upstream state, and remote divergence; understand the semantic ownership of the outstanding paths.
- Preserve coherent valuable changes with explicit commits when authorized, while leaving unrelated user work untouched. Do not stash, delete, reset, clean, overwrite, or fold unrelated changes into the task merely to make the tree clean.
- Unrelated dirty paths do not by themselves prohibit publishing already-committed work. When push is authorized, complete safe fetch/reconciliation/publication rather than stopping at a non-clean worktree.
- Stop only for a real capability/safety boundary, an unresolved destructive or commingling risk, a conflict that repository evidence cannot safely resolve, or a genuine human decision.

Mandatory Canonization bootstrap:
- Before new architectural conclusions, naming/tree judgments, or patches, locate the canonical local `Canonization` repository in the shared workspace and treat it as READ_ONLY reference material unless Canonization itself is the explicit target workspace.
- Read the relevant materialized textual canon rules themselves. Discover and inspect the normative rule documents/catalogs actually present in Canonization; do not rely only on memory, README summaries, prior-chat statements, or Gating results.
- Reconcile the current target state and prior progress against those applicable textual rules. Preserve prior work only where it remains canon-compliant; surface and correct drift when the target conflicts with an applicable canon rule.
- Treat Gating as the executable enforcement companion, not a substitute for reading Canonization. Avoid duplicating checks that are already fully automated when the task is specifically about owner/architectural canon.
- For WRITE_ALLOWED runs, record newly consulted Canonization rule files/rules and target mappings in `CMCP_CHANGELOG.md`.

Continuation report requirement:
- Укажи, что было продолжено, что изменилось, какие проверки выполнены и какое следующее безопасное действие.
- В длительной работе сообщай: «Что достигнуто? Что осталось до RC?»
