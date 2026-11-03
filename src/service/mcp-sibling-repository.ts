import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve repository identity independently of cwd and filesystem casing. */
export function resolveMcpSiblingRepository(name: "browsing" | "looping", repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))): string {
  const checkoutParent = resolve(repositoryRoot, "..");
  // Git worktrees live in mcp/.worktrees; resolve siblings from the MCP root.
  const parent = checkoutParent.endsWith("/.worktrees") ? resolve(checkoutParent, "..") : checkoutParent;
  const preferred = resolve(parent, name);
  const find = (directory: string, identity: string): string | undefined => {
    try {
      const entry = readdirSync(directory, { withFileTypes: true }).find((item) =>
        (item.isDirectory() || item.isSymbolicLink()) && item.name.toLowerCase() === identity);
      return entry ? resolve(directory, entry.name) : undefined;
    } catch { return undefined; }
  };
  const hasDefinitions = (directory: string) => name !== "browsing"
    || existsSync(resolve(directory, "mcp-server", "src", "web-domain-tool-definitions.cjs"));
  const sibling = find(parent, name);
  if (sibling && hasDefinitions(sibling)) return sibling;
  if (existsSync(preferred) && hasDefinitions(preferred)) return preferred;
  if (name === "browsing") {
    const looping = find(parent, "looping");
    const nested = looping && find(looping, name);
    if (nested && hasDefinitions(nested)) return nested;
  }
  return preferred;
}
