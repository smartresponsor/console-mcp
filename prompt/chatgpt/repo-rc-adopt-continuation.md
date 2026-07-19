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

Execution budget:
- Maximum automatic interaction cycles: {{maxAutoIterations}}.
- In the original CLI command, `M{{maxAutoIterations}}` is exclusively the `maxAutoIterations` flag value.
- Never interpret `M<number>` from an adopt command as a milestone, roadmap item, phase, wave, task number, or repository objective.
- Repository milestones must be selected only from explicit specification text and must not be inferred from the CLI execution-budget token.

Continuation report requirement:
- Укажи, что было продолжено, что изменилось, какие проверки выполнены и какое следующее безопасное действие.
- В длительной работе сообщай: «Что достигнуто? Что осталось до RC?»
