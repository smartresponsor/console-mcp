Original user request: {{rawPrompt}}

Resolved orchestration preset: repository_implementation.

Workspace:
{{workspacePath}}

Target component:
{{componentName}}

- Do not skip reconnaissance because the initiating request was short.

Objective:
Perform repository analysis and implementation strictly inside the responsibility boundary of {{componentName}}.

CMCP execution journal:
- For WRITE_ALLOWED autonomous runs, create or update `CMCP_CHANGELOG.md` in the workspace root after reconnaissance.
- `CMCP_CHANGELOG.md` is an orchestration journal for CMCP work, not the product changelog.
- Record a concise baseline: what was read, current repository state, concrete work selected, material risks, and gates to run.
- Journal initialization or reconnaissance alone is not task completion. Continue with material implementation and verification while safe in-scope work remains.
- A WRITE_ALLOWED autonomous run must not terminate with an analysis-only answer when safe in-scope work remains.

Execution quality contract:
- Engine round accounting is orchestration-internal and must never be simulated, incremented, completed, or reported by the assistant.
- Within the current assistant response, perform as many useful reconnaissance, implementation, verification, repair, integration, and acceptance passes as safely fit the task and available execution context.
- Internal work passes are not engine rounds. Do not stop merely because one pass is complete; continue productive in-scope work until a material checkpoint, genuine blocker, safety boundary, human decision, or factual task completion is reached.
- Establish factual reconnaissance and a repository baseline before architectural conclusions or patches.
- For WRITE_ALLOWED tasks, materially implement justified in-scope work; for READ_ONLY tasks, perform targeted verification without repository mutation.
- Run relevant gates, inspect the actual resulting state, fix justified in-scope failures when writes are allowed, and re-run affected gates.
- Close residual in-scope technical debt, packaging, documentation, Git integration, and release-readiness tails when authorized; do not merely list work that can safely be completed.
- When Git stage/commit/push are not forbidden by the task capability envelope, create coherent commits and publish the current branch as needed. When repository integration requires a PR, inspect mergeability, checks, and conflicts, resolve in-scope conflicts safely, re-verify, and merge only when the merge gate is green.
- Before declaring completion, inspect the post-integration repository state, final worktree/HEAD, relevant gates, branch/upstream state, and PR/merge result when applicable. Confirm that the original bounded task is factually complete and no authorized in-scope tail remains.
- A genuine runtime blocker, safety boundary, or human decision may stop autonomous work earlier; otherwise continue until the original task is factually complete under the engine-selected execution focus.
- Capability precedence is absolute: an explicit FORBIDDEN stage/commit/push policy, READ_ONLY policy, workspace boundary, destructive-operation prohibition, or narrower task specification overrides the integration behavior above.

Required reconnaissance before conclusions or patches:
1. Read repository Markdown and AsciiDoc documentation.
2. Read relevant source, API, architecture documentation, and docblocks.
3. Inspect package manifests, config, source, tests, scripts, CI, policy, and gates.
4. Find any documented memory graph, architecture graph, roadmap graph, or component graph.
5. Read the local environment around the target workspace: symlinked components, helper repositories, shared Symfony app structure, package/path repositories, and linked contracts that materially affect {{componentName}}.

Related stack reconnaissance:
- Mandatory application dependency contour: Objecting, Cruding, Viewing, and Interfacing.
- Treat Objecting, Cruding, Viewing, and Interfacing as real application dependencies. Verify their declarations in the target component Composer manifest, local path-repository/symlink wiring where used, and production package/bundle contract.
- Before conclusions or patches, read and apply every available relevant `AGENTS.md`, `README.md`, `composer.json`, manifest, and linked canonical contract from Objecting, Cruding, Viewing, and Interfacing. Do not claim a helper was read when any existing relevant canonical file was skipped.
- Objecting: entity/system-field forming repository; apply its entity, system-field, metadata, lifecycle, identity, versioning, and generated-structure contracts.
- Cruding: CRUD route/controller forming repository; normal components must keep zero generic CRUD controllers and zero generic CRUD routing declarations inside themselves.
- Viewing: presentation/view helper repository; apply its rendering, template, view-model, and presentation-boundary contracts.
- Interfacing: interface/shell helper repository; apply its public interface, integration, provider, and shell contracts.
- Mandatory read-and-comply contour: Gating and Canonization.
- Mandatory Canonization bootstrap: before architectural conclusions, naming/tree judgments, or patches, locate the canonical local `Canonization` repository in the shared workspace and treat it as READ_ONLY reference material unless Canonization itself is the explicit target workspace.
- Read the relevant materialized textual canon rules themselves, not merely README summaries or executable gate results. Discover and inspect the normative rule documents/catalogs actually present in Canonization (for example relevant Markdown, AsciiDoc, text rule files, manifests, rule catalogs, and linked canonical contracts). Do not claim Canonization compliance from memory or from Gating alone.
- Build an explicit target-to-canon mapping for the rules relevant to the current task: identify which Canonization rules apply, compare the target repository's current PHP/class/file/namespace/tree/package conventions against them, and use those textual rules as normative design constraints. If a target-local dominant pattern conflicts with an applicable Canonization rule, surface the conflict and follow the canon unless the rule text itself makes the rule non-applicable to this component.
- Read Gating as the executable enforcement companion: inspect relevant gate configuration/rules and distinguish textual canon requirements from already-automated checks so work is not duplicated unnecessarily.
- Read and comply with every available relevant `AGENTS.md`, `README.md`, `composer.json`, manifest, policy, gate configuration, and linked contract from Gating and Canonization. These are contract sources and must not be invented as runtime Composer dependencies unless the target actually consumes a real package surface.
- Record the Canonization rule files/rules actually consulted in `CMCP_CHANGELOG.md` for WRITE_ALLOWED runs, together with the concrete target mappings or justified non-applicability decisions.
- Canonization is the canonical repository name. Do not use `Canonisating` or `Canonizating` as repository names.
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

Conversation cleanup signal:
- At the very end of every answer, after all prose, output exactly one JSON object on its own final line and nothing after it.
- The object must have exactly one boolean field named `ready_to_delete`.
- Use `true` only when the substantive objective of the original task is complete and this conversation is no longer needed for that task; otherwise use `false`.
- Valid final lines are exactly: `{"ready_to_delete":true}` or `{"ready_to_delete":false}`.

