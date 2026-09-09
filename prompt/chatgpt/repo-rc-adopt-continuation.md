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

Mandatory Canonization bootstrap:
- Before new architectural conclusions, naming/tree judgments, or patches, locate the canonical local `Canonization` repository in the shared workspace and treat it as READ_ONLY reference material unless Canonization itself is the explicit target workspace.
- Read the relevant materialized textual canon rules themselves. Discover and inspect the normative rule documents/catalogs actually present in Canonization; do not rely only on memory, README summaries, prior-chat statements, or Gating results.
- Reconcile the current target state and prior progress against those applicable textual rules. Preserve prior work only where it remains canon-compliant; surface and correct drift when the target conflicts with an applicable canon rule.
- Treat Gating as the executable enforcement companion, not a substitute for reading Canonization. Avoid duplicating checks that are already fully automated when the task is specifically about owner/architectural canon.
- For WRITE_ALLOWED runs, record newly consulted Canonization rule files/rules and target mappings in `CMCP_CHANGELOG.md`.

Continuation report requirement:
- Укажи, что было продолжено, что изменилось, какие проверки выполнены и какое следующее безопасное действие.
- В длительной работе сообщай: «Что достигнуто? Что осталось до RC?»
