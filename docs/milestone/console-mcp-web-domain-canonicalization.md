# Console MCP Web Domain Canonicalization

## Goal

Replace the public capability domain token `network` with the semantic domain `web`.

The public capability surface must describe what a capability does. Provider/component provenance belongs in implementation and contract metadata, not in the public capability identifier.

## Target canon

```text
read_.web.<resource>.<action>
write.web.<resource>.<action>
```

Browser-specific resources remain nested beneath `web` when the browser itself is the subject:

```text
read_.web.browser.status
read_.web.browser.inventory
read_.web.browser.targets
write.web.browser.open
write.web.browser.bind
```

Web interaction capabilities use semantic resources directly:

```text
write.web.target.open
write.web.job.open
read_.web.page.capture
read_.web.page.wait
write.web.page.click
read_.web.form.inspect
read_.web.form.extract
write.web.form.proposal.preview
write.web.form.fill
write.web.form.upload
write.web.form.review.snapshot
write.web.form.submit
```

## Boundary

The existing `browser.*` Console domain remains reserved for Console-owned supervised browser/ChatGPT runtime orchestration such as `browser.chatgpt.*`, `browser.session.*`, and browser housekeeping.

The `web.*` domain represents interaction with external web surfaces through that browser runtime.

## Provider identity

The backing provider may remain `browser-mcp`.

Internal provider-owned names such as `network.inspect`, `network.click`, and `network.submit_after_approval` remain valid inside the Browser MCP contract.

Provider identity and capability ownership must be expressed through metadata such as `capabilityOwner=browser-mcp`, not by leaking `network` into the Console public capability ontology.

## Completion criteria

1. No live Console MCP tool begins with `read_.network.` or `write.network.`.
2. All corresponding public tools use `read_.web.` / `write.web.`.
3. Policy metadata uses `domain: web` for those public tools.
4. Browser MCP internal contract names and owner metadata remain unchanged.
5. Catalog, admission, registration, typecheck, and smoke checks pass.
6. Live `system.console.describe` confirms the web-domain surface.
