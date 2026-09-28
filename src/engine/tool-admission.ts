import fs from "node:fs";

export type ToolKind =
  | "atomic"
  | "domainCapability"
  | "recipe"
  | "orchestrationControl"
  | "runtimeMaintenance";

export type ToolLifecycle = "experimental" | "admitted" | "deprecated" | "retired";
export type ConsumerName = "chatgpt" | "codex" | "runner";

export type ToolAdmissionDeclaration = {
  name: string;
  kind: ToolKind;
  risk: "read_" | "write";
  consumers: ConsumerName[];
  lifecycle: ToolLifecycle;
  source: string | null;
  admittedAt?: string;
  deprecatedAt?: string;
  retiredAt?: string;
  legacyNames?: string[];
  retirementEvidence?: {
    supportedConsumerLiteralRefs: number;
    legacyAliasLiteralRefs?: number;
    scannedConsumers: string[];
  };
};

type ToolAdmissionManifest = {
  schemaVersion: number;
  id: string;
  status: string;
  declarations: ToolAdmissionDeclaration[];
};

const manifestUrl = new URL("../../policy/console-tool-admission.json", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8")) as ToolAdmissionManifest;

if (manifest.schemaVersion !== 1 || manifest.id !== "console-tool-admission" || manifest.status !== "active") {
  throw new Error("Console tool admission manifest is invalid or inactive.");
}

const declarations = new Map<string, ToolAdmissionDeclaration>();
for (const declaration of manifest.declarations) {
  if (declarations.has(declaration.name)) {
    throw new Error(`Duplicate Console tool admission declaration: ${declaration.name}`);
  }
  declarations.set(declaration.name, declaration);
}

export function getToolAdmissionDeclaration(name: string): ToolAdmissionDeclaration {
  const declaration = declarations.get(name);
  if (!declaration) {
    throw new Error(`Console tool is not admitted: ${name}`);
  }
  return declaration;
}

export function listToolAdmissionDeclarations(): ReadonlyArray<ToolAdmissionDeclaration> {
  return [...declarations.values()];
}

export function declarationVisibleToConsumer(declaration: ToolAdmissionDeclaration, consumer: ConsumerName): boolean {
  if (declaration.lifecycle === "retired") {
    return false;
  }
  return declaration.consumers.includes(consumer);
}
