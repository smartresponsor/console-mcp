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
- For WRITE_ALLOWED autonomous runs, the first execution iteration must create or update `CMCP_CHANGELOG.md` in the workspace root after reconnaissance.
- `CMCP_CHANGELOG.md` is an orchestration journal for CMCP work, not the product changelog.
- Record a concise baseline: what was read, current repository state, concrete work selected, material risks, and gates to run.
- Journal initialization or reconnaissance alone is not task completion. Use later iterations to materially implement and verify the task while budget remains.
- A WRITE_ALLOWED autonomous run must not terminate with an analysis-only answer when safe in-scope work remains.

Minimum three-iteration execution contract:
1. Iteration 1 — RECONNAISSANCE_AND_BASELINE: inspect facts, establish scope/baseline, and update `CMCP_CHANGELOG.md` when writes are allowed.
2. Iteration 2 — MATERIAL_IMPLEMENTATION for WRITE_ALLOWED tasks; TARGETED_VERIFICATION for READ_ONLY tasks. Do not spend this iteration merely repeating reconnaissance.
3. Iteration 3 — VERIFICATION_AND_CONTINUATION_DECISION: run relevant gates, inspect the actual resulting state, update the CMCP journal when allowed, and decide whether more bounded work remains.
- Normal autonomous completion is not valid before iteration 3. A genuine runtime blocker, safety boundary, or human decision may still stop the run earlier.
- Iterations 4+ are CONTINUOUS_RC_EXECUTION: continue implementing, repairing, verifying, and packaging until the original task is factually complete or the authorized budget is exhausted.

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
- Read and comply with every available relevant `AGENTS.md`, `README.md`, `composer.json`, manifest, policy, gate configuration, and linked contract from Gating and Canonization. These are contract sources and must not be invented as runtime Composer dependencies unless the target actually consumes a real package surface.
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

