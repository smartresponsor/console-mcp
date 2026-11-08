/** Explicit first facade boundary; the canonical registry and broker remain authoritative. */
export const RELEASE_FACADE_TOOL_NAMES = [
  "read_.release.runtime.status",
  "read_.release.transaction.status",
  "write.release.transaction.prepare",
  "write.release.transaction.validate",
  "write.release.transaction.activate",
  "write.release.transaction.rollback",
] as const;

export function releaseFacadeToolNames(
  canonicalNames: ReadonlySet<string>,
  admittedChatGptNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const missing = RELEASE_FACADE_TOOL_NAMES.filter(
    (name) => !canonicalNames.has(name) || !admittedChatGptNames.has(name),
  );
  if (missing.length > 0) {
    throw new Error(`Release facade cannot publish unregistered or unadmitted tools: ${missing.join(", ")}`);
  }
  return new Set(RELEASE_FACADE_TOOL_NAMES);
}
