Original user request: {{rawPrompt}}

Resolved orchestration preset: repo_rc_implementation.

Workspace:
{{workspacePath}}

Target component:
{{componentName}}

Entrypoint expansion:
- This prompt was expanded by console-mcp from a shorter user request.
- Preserve the original intent while applying the structured execution contract below.
- Do not skip reconnaissance because the original request was short.

Execution budget:
- Maximum automatic interaction cycles: {{maxAutoIterations}}.
- In the original CLI command, `M{{maxAutoIterations}}` is exclusively the `maxAutoIterations` flag value.
- Never interpret `M<number>` from a `cmcp go` or `Cmcp go` command as a milestone, roadmap item, phase, wave, task number, or repository objective.
- Repository milestones must be selected only from explicit specification text and must not be inferred from the CLI execution-budget token.

Objective:
Perform a deep release-candidate analysis and implementation pass strictly inside the responsibility boundary of {{componentName}}.

Required reconnaissance before conclusions or patches:
1. Read repository Markdown and AsciiDoc documentation.
2. Read relevant source, API, architecture documentation, and docblocks.
3. Inspect package manifests, config, source, tests, scripts, CI, policy, and gates.
4. Find any documented memory graph, architecture graph, roadmap graph, or component graph.
5. Read the local environment around the target workspace: symlinked components, helper repositories, shared Symfony app structure, package/path repositories, and linked contracts that materially affect {{componentName}}.

Related stack reconnaissance:
- Objecting: entity/system-field forming repository; read it for entities, system fields, metadata, lifecycle fields, identity fields, or generated entity structure.
- Cruding: CRUD route/controller forming repository; normal components must keep zero Cruding controllers and zero Cruding routing declarations inside themselves.
- Canonisating: canonical contract/interface and convention source of truth; read it for cross-component contracts, canon rules, naming, structure, and shared conventions.
- Viewing and Interfacing: presentation/shell helper repositories; read them for rendering, templates, UI shell, view models, or interface integration.
- Navigating: sensitive menu/navigation helper; prefer not to patch it unless a navigation item change is clearly required and the boundary impact is understood.
- Keep responsibilities in their owning repositories; use helpers to understand the environment and preserve boundaries.

Required opening mixin:
- Start by analyzing market, competitors, mature open-source projects, SaaS products, and enterprise practices within the single responsibility boundary of the target component.
- Identify baseline market expectations, advanced maturity capabilities, relevant fragility, technical debt, safeguards, and practices that must stay outside this component boundary.
- Derive one RC-critical workstream for technical debt, hardening, fixes, boundary enforcement, tests, gates, observability, diagnostics, lifecycle safety, and factual documentation.
- Derive a separate growth workstream for maturity uplift, UX/DX/API improvements, capability growth, competitive parity or advantage, and post-RC roadmap items that do not violate the boundary.
- Keep RC-critical work separate from growth work; do not block RC on speculative growth unless it is required for correctness, safety, or operability.
- After each major pass, close with: Что имеем? Что осталось?
- Every intermediate progress message during long RC work must include: Что достигнуто? Что осталось до RC?

