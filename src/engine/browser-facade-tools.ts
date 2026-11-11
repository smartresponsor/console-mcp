/** Fail-closed Browser capability projection. No handler, permission, or auth bypass. */
export const BROWSER_FACADE_TOOL_NAMES = [
  "read_.web.browser.status",
  "read_.web.browser.inventory",
  "read_.web.browser.targets",
  "read_.web.capability.contract",
  "read_.web.chatgpt.snapshot",
  "read_.web.session.lease.status",
  "read_.web.page.capture",
  "read_.web.page.capture.dom",
  "read_.web.page.capture.form",
  "read_.web.page.wait",
  "read_.web.form.inspect",
  "read_.web.form.extract",
  "write.web.browser.open",
  "write.web.browser.close",
  "write.web.browser.bind",
  "write.web.job.open",
  "write.web.target.open",
  "write.web.page.click",
  "write.web.form.proposal.preview",
  "write.web.form.fill",
  "write.web.form.upload",
  "write.web.artifact.import",
  "write.web.form.review.snapshot",
  "write.web.form.submit",
] as const;

export function browserFacadeToolNames(
  canonicalNames: ReadonlySet<string>,
  admittedChatGptNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const missing = BROWSER_FACADE_TOOL_NAMES.filter(
    (name) => !canonicalNames.has(name) || !admittedChatGptNames.has(name),
  );
  if (missing.length > 0) {
    throw new Error(`Browser facade cannot publish unregistered or unadmitted tools: ${missing.join(", ")}`);
  }
  return new Set(BROWSER_FACADE_TOOL_NAMES);
}
