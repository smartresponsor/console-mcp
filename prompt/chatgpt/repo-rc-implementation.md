Original user request: {{rawPrompt}}

Resolved orchestration preset: repository_implementation.

Workspace:
{{workspacePath}}

Target component:
{{componentName}}

- Do not skip reconnaissance because the initiating request was short.

Objective:
Perform repository analysis and implementation strictly inside the responsibility boundary of {{componentName}}.

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

