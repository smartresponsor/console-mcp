import type { CanonicalToolRegistry, ConsumerToolProjection } from "./canonical-tool-registry.js";

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

/** Fail-closed projection of the canonical repository Git capabilities. */
export const OWNER_REPO_FACADE_TOOL_NAMES = [
  "read_.git.repo.inspect",
  "read_.git.repo.compare",
  "write.git.repo.fetch",
  "write.git.repo.fast_forward",
  "read_.repo.git.branch.status",
  "read_.repo.git.diff",
  "read_.repo.git.diff.stat",
  "read_.repo.git.file.log",
  "read_.repo.git.file.show",
  "read_.repo.git.grep",
  "read_.repo.git.reflog.search",
  "read_.repo.git.remote.summary",
  "read_.repo.git.sync.plan",
  "read_.repo.git.worktree.list",
  "read_.repo.workspace.status",
  "write.repo.git.archive.ref.push",
  "write.repo.git.branch.create",
  "write.repo.git.branch.push",
  "write.repo.git.branch.switch",
  "write.repo.git.checkout.file",
  "write.repo.git.commit.signed",
  "write.repo.git.fetch",
  "write.repo.git.init",
  "write.repo.git.merge.reviewed",
  "write.repo.git.pull.ff.only",
  "write.repo.git.push.current",
  "write.repo.git.push.current.branch",
  "write.repo.git.push.current.set.upstream",
  "write.repo.git.rebase",
  "write.repo.git.remote.add",
  "write.repo.git.safe.directory.add",
  "write.repo.git.stage",
  "write.repo.git.untrack",
  "write.repo.git.worktree.create",
  "write.repo.git.worktree.remove",
  "write.repo.file.replace.text",
  "write.repo.patch.apply",
  "write.repo.path.move",
  "write.repo.workspace.create",
  "write.repo.documentating.site.build",
  "write.repo.documentating.site.publish",
] as const;

/** Exclude owner capabilities from every ordinary consumer, not just ChatGPT.
 * Canonical admission remains unchanged; no implicit bearer-to-OAuth delegation. */
export function excludeOwnerRepositoryTools(registry: CanonicalToolRegistry, projection: ConsumerToolProjection): ConsumerToolProjection {
  const owned = new Set<string>(OWNER_REPO_FACADE_TOOL_NAMES);
  return registry.forConsumerIncluding(projection.consumer, new Set([...projection.toolNames].filter(n => !owned.has(n))));
}

export function ownerRepoFacadeToolNames(
  canonicalNames: ReadonlySet<string>,
  admittedChatGptNames: ReadonlySet<string>,
  includeDocumentatingReview = false,
): ReadonlySet<string> {
  const names = OWNER_REPO_FACADE_TOOL_NAMES.filter(name => includeDocumentatingReview || !name.startsWith("write.repo.documentating.site."));
  const missing = names.filter(
    (name) => !canonicalNames.has(name) || !admittedChatGptNames.has(name),
  );
  if (missing.length > 0) {
    throw new Error(`Repo facade cannot publish unregistered or unadmitted tools: ${missing.join(", ")}`);
  }
  return new Set(names);
}

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
