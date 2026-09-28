import fs from "node:fs/promises";
import path from "node:path";

export async function projectConsoleToolAdmission(root) {
  const indexPath = "policy/console-tool-catalog-index.json";
  const index = JSON.parse(await fs.readFile(path.join(root, indexPath), "utf8"));
  const overridePath = "policy/console-tool-admission-overrides.json";
  const overrideConfig = JSON.parse(await fs.readFile(path.join(root, overridePath), "utf8"));
  const defaults = overrideConfig.defaults ?? {};
  const overrides = overrideConfig.overrides ?? {};
  const declarations = [];
  const ownerByName = new Map();

  for (const fragmentPath of index.fragments ?? []) {
    const fragment = JSON.parse(await fs.readFile(path.join(root, fragmentPath), "utf8"));
    for (const tool of fragment.tools ?? []) {
      const names = [tool.canonicalName, ...(tool.canonicalReadAliases ?? [])].filter(Boolean);
      for (const name of names) {
        const existingOwner = ownerByName.get(name);
        if (existingOwner && existingOwner !== fragmentPath) {
          throw new Error(`catalog admission name has multiple fragment owners: ${name} (${existingOwner}, ${fragmentPath})`);
        }
        if (existingOwner === fragmentPath) continue;
        ownerByName.set(name, fragmentPath);
        const override = overrides[name] ?? {};
        const declaration = {
          name,
          ...(override.lexicalException === true ? { lexicalException: true } : {}),
          ...(typeof override.justification === "string" ? { justification: override.justification } : {}),
          kind: override.kind ?? defaults.kind ?? "atomic",
          risk: name.split(".")[1],
          consumers: override.consumers ?? defaults.consumers ?? ["chatgpt", "codex", "runner"],
          lifecycle: override.lifecycle ?? defaults.lifecycle ?? "admitted",
          source: fragmentPath,
        };
        declarations.push(declaration);
      }
    }
  }

  for (const name of Object.keys(overrides)) {
    if (!ownerByName.has(name)) throw new Error(`admission override has no catalog declaration: ${name}`);
  }

  declarations.sort((a, b) => a.name.localeCompare(b.name));
  return {
    schemaVersion: 1,
    id: "console-tool-admission",
    status: "active",
    generatedFrom: indexPath,
    overridesFrom: overridePath,
    declarations,
  };
}

export function stableAdmissionJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}
