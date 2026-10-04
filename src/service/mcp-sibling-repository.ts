import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve repository identity independently of cwd and filesystem casing. */
export function resolveMcpSiblingRepository(name: "browsing" | "looping", repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))): string {
  const parent = resolve(repositoryRoot, "..");
  const preferred = resolve(parent, name);
  if (existsSync(preferred)) return preferred;
  try {
    const entry = readdirSync(parent, { withFileTypes: true }).find((item) =>
      (item.isDirectory() || item.isSymbolicLink()) && item.name.toLowerCase() === name);
    if (entry) return resolve(parent, entry.name);
  } catch {}
  return preferred;
}
