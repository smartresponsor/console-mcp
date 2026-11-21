/** Reviewed immutable test targets; changing this list requires normal PR review.
 * A remote-tracking ref is a provenance check, not an execution authorization.
 * Do not accept caller-supplied scripts, arbitrary commits or dynamic branch heads.
 */
export const approvedIsolatedTestSha = "2397dd4203b07d8cce770d87862bef037e762faa" as const;
export const approvedIsolatedTestProfile = "mcp-http-efficiency" as const;

export function assertApprovedIsolatedTestSha(sha: string): void {
  if (sha !== approvedIsolatedTestSha) throw new Error("ISOLATED_TEST_SHA_NOT_APPROVED");
}
