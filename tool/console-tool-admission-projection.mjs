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
        const kind = override.kind ?? defaults.kind ?? "atomic";
        const lifecycle = override.lifecycle ?? defaults.lifecycle ?? "admitted";
        const derivedConsumers = deriveConsumers(kind, lifecycle);
        const consumers = resolveConsumers(name, override, derivedConsumers);
        const declaration = {
          name,
          ...(override.lexicalException === true ? { lexicalException: true } : {}),
          ...(typeof override.justification === "string" ? { justification: override.justification } : {}),
          ...(typeof override.admittedAt === "string" ? { admittedAt: override.admittedAt } : {}),
          ...(typeof override.deprecatedAt === "string" ? { deprecatedAt: override.deprecatedAt } : {}),
          ...(typeof override.retiredAt === "string" ? { retiredAt: override.retiredAt } : {}),
          ...(Array.isArray(override.legacyNames) ? { legacyNames: override.legacyNames } : {}),
          ...(override.retirementEvidence && typeof override.retirementEvidence === "object"
            ? { retirementEvidence: override.retirementEvidence }
            : {}),
          kind,
          risk: name.split(".")[0],
          consumers,
          lifecycle,
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

function deriveConsumers(kind, lifecycle) {
  if (lifecycle === "retired") return [];
  const consumers = [];
  if ((kind === "atomic" || kind === "domainCapability")
    && (lifecycle === "admitted" || lifecycle === "deprecated")) {
    consumers.push("chatgpt", "codex");
  }
  if (lifecycle === "experimental" || lifecycle === "admitted" || lifecycle === "deprecated") {
    consumers.push("runner");
  }
  return consumers;
}

function resolveConsumers(name, override, derivedConsumers) {
  if (!Array.isArray(override.consumers)) return derivedConsumers;
  if (!(typeof override.justification === "string" && override.justification.trim() !== "")) {
    throw new Error(`explicit consumer override requires justification: ${name}`);
  }
  for (const consumer of override.consumers) {
    if (!derivedConsumers.includes(consumer)) {
      throw new Error(`explicit consumer override may narrow but not broaden derived visibility: ${name} -> ${consumer}`);
    }
  }
  return [...override.consumers];
}
