import { consoleToolNames as coreConsoleToolNames } from "./catalog-core.js";

export const consoleToolNames = [
  ...coreConsoleToolNames,
  "console.write.package.npm.install",
] as const;

export function assertConsoleToolCatalogContains(requiredToolNames: readonly string[]): void {
  const known = new Set<string>(consoleToolNames);
  const missing = requiredToolNames.filter((toolName) => !known.has(toolName));
  if (missing.length > 0) {
    throw new Error(`consoleToolNames catalog is missing registered tools: ${missing.join(", ")}`);
  }
}
