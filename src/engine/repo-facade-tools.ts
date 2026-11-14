/** Fail-closed projection of the canonical repository Git capabilities. */
export const REPO_FACADE_TOOL_NAMES = [
  "write.repo.git.merge.reviewed",
  "write.repo.git.archive.ref.push",
  "write.repo.git.push.current.branch",
  "write.repo.git.branch.push",
  "write.repo.git.safe.directory.add",
  "write.repo.git.worktree.create",
  "read_.repo.git.worktree.list",
  "write.repo.git.worktree.remove",
] as const;

export function repoFacadeToolNames(
  canonicalNames: ReadonlySet<string>,
  admittedChatGptNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const missing = REPO_FACADE_TOOL_NAMES.filter(
    (name) => !canonicalNames.has(name) || !admittedChatGptNames.has(name),
  );
  if (missing.length > 0) {
    throw new Error(`Repo facade cannot publish unregistered or unadmitted tools: ${missing.join(", ")}`);
  }
  return new Set(REPO_FACADE_TOOL_NAMES);
}
