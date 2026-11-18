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

// Stage 06: candidate Release lifecycle capabilities, separate from the five
// already published Transaction commands. Never automatically cut over main.
export const RELEASE_LIFECYCLE_CANDIDATE_NAMES = [
  "read_.release.runtime.status",
  "write.release.artifact.prepare",
  "write.release.artifact.validate",
  "write.release.runtime.activate",
  "write.release.runtime.rollback",
] as const;

export function releaseExtendedFacadeToolNames(
  canonicalNames: ReadonlySet<string>,
  admittedChatGptNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const existing = new Set(releaseTransactionFacadeToolNames(canonicalNames, admittedChatGptNames));
  for (const name of RELEASE_LIFECYCLE_CANDIDATE_NAMES) {
    if (!canonicalNames.has(name) || !admittedChatGptNames.has(name) || existing.has(name)) {
      throw new Error(`Release extension ownership invalid: ${name}`);
    }
    existing.add(name);
  }
  if (existing.size !== 10) throw new Error("Release extended ownership count mismatch");
  return existing;
}
