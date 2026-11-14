/** Fail-closed projection of the existing canonical release transaction capabilities. */
export const RELEASE_TRANSACTION_FACADE_TOOL_NAMES = [
  "read_.release.transaction.status",
  "write.release.transaction.prepare",
  "write.release.transaction.validate",
  "write.release.transaction.activate",
  "write.release.transaction.rollback",
] as const;

export function releaseTransactionFacadeToolNames(
  canonicalNames: ReadonlySet<string>,
  admittedChatGptNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const missing = RELEASE_TRANSACTION_FACADE_TOOL_NAMES.filter(
    (name) => !canonicalNames.has(name) || !admittedChatGptNames.has(name),
  );
  if (missing.length > 0) {
    throw new Error(`Release transaction facade cannot publish unregistered or unadmitted tools: ${missing.join(", ")}`);
  }
  return new Set(RELEASE_TRANSACTION_FACADE_TOOL_NAMES);
}
