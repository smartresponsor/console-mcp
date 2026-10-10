import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve repository identity independently of cwd and filesystem casing. */
export function resolveMcpSiblingRepository(name: "browsing" | "looping", repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))): string {
  const parent = resolve(repositoryRoot, "..");
  const preferred = resolve(parent, name);
  if (existsSync(preferred)) return preferred;
  const find = (directory: string, identity: string): string | undefined => {
    try {
      const entry = readdirSync(directory, { withFileTypes: true }).find((item) =>
        (item.isDirectory() || item.isSymbolicLink()) && item.name.toLowerCase() === identity);
      return entry ? resolve(directory, entry.name) : undefined;
    } catch { return undefined; }
  };
  const sibling = find(parent, name);
  if (sibling) return sibling;
  if (name === "browsing") {
    const looping = find(parent, "looping");
    const nested = looping && find(looping, name);
    if (nested) return nested;
  }
  return preferred;
}
