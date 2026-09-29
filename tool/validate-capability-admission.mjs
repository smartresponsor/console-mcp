import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectConsoleToolAdmission } from "./console-tool-admission-projection.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readText = (relative) => readFile(path.join(root, relative), "utf8");
const manifest = JSON.parse(await readText("policy/console-tool-admission.json"));
const errors = [];
const projectedManifest = await projectConsoleToolAdmission(root);
if (JSON.stringify(manifest) !== JSON.stringify(projectedManifest)) {
  errors.push("admission manifest drifted from catalog fragments plus semantic overrides");
}
const kinds = new Set(["atomic","domainCapability","recipe","orchestrationControl","runtimeMaintenance"]);
const lifecycles = new Set(["experimental","admitted","deprecated","retired"]);
const consumersAllowed = new Set(["chatgpt","codex","runner"]);
const modelKinds = new Set(["atomic","domainCapability"]);
const namePattern = /^(read_|write)\.[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

if (manifest.schemaVersion !== 1 || manifest.id !== "console-tool-admission" || manifest.status !== "active") {
  errors.push("admission manifest header is invalid");
}
const declarations = new Map();
for (const item of manifest.declarations ?? []) {
  if (declarations.has(item.name)) errors.push("duplicate declaration: " + item.name);
  declarations.set(item.name, item);
  const consumers = Array.isArray(item.consumers) ? item.consumers : [];
  if (!namePattern.test(item.name) && item.lexicalException !== true) errors.push("non-canonical name without explicit lexical exception: " + item.name);
  if (item.lexicalException === true && !(typeof item.justification === "string" && item.justification.trim().length > 0)) errors.push("lexical exception missing justification: " + item.name);
  if (!kinds.has(item.kind)) errors.push("invalid kind: " + item.name);
  if (!lifecycles.has(item.lifecycle)) errors.push("invalid lifecycle: " + item.name);
  if (item.risk !== item.name.split(".")[0]) errors.push("risk mismatch: " + item.name);
  if ((item.lifecycle !== "retired" && consumers.length === 0) || new Set(consumers).size !== consumers.length) errors.push("invalid consumers: " + item.name);
  for (const consumer of consumers) if (!consumersAllowed.has(consumer)) errors.push("unknown consumer: " + item.name);
  const modelVisible = consumers.includes("chatgpt") || consumers.includes("codex");
  if (!modelKinds.has(item.kind) && modelVisible) errors.push("non-model kind is model-visible: " + item.name);
  if (item.lifecycle === "admitted" && modelKinds.has(item.kind)) {
    for (const consumer of ["chatgpt","codex","runner"]) if (!consumers.includes(consumer)) errors.push("model capability missing " + consumer + ": " + item.name);
  }
  if (item.lifecycle === "admitted" && !modelKinds.has(item.kind) && !(consumers.length === 1 && consumers[0] === "runner")) {
    errors.push("runner-only kind has invalid consumers: " + item.name);
  }
  if (item.lifecycle === "retired" && consumers.length > 0) errors.push("retired tool is visible: " + item.name);
}

const catalogText = await readText("src/tool/catalog.ts");
const catalogNames = [...catalogText.matchAll(/"((?:read_|write)\.[^"]+)"/g)].map((m) => m[1]);
for (const name of catalogNames) if (!declarations.has(name)) errors.push("catalog tool is not admitted: " + name);

const { readdir } = await import("node:fs/promises");
const toolDir = path.join(root, "src", "tool");
const toolFiles = (await readdir(toolDir)).filter((name) => name.endsWith(".ts"));
const sourceText = (await Promise.all(toolFiles.map((name) => readFile(path.join(toolDir, name), "utf8")))).join("\n");
const registeredNames = new Set(
  [...sourceText.matchAll(/["']((?:read_|write)\.[^"']+)["']/g)].map((match) => match[1]),
);
for (const name of registeredNames) if (!declarations.has(name)) errors.push("registered tool is not admitted: " + name);
for (const [name,item] of declarations) if (item.lifecycle !== "retired" && !registeredNames.has(name)) errors.push("admitted tool is not registered: " + name);

const registry = await readText("src/engine/canonical-tool-registry.ts");
if (registry.includes("TOOL_CONSUMER_OVERRIDES")) errors.push("manual consumer overrides must not be reintroduced");
if (!registry.includes("getToolAdmissionDeclaration")) errors.push("registry must resolve admission declarations");
if (!registry.includes("declarationVisibleToConsumer")) errors.push("registry visibility must derive from declarations");

if (errors.length) {
  console.error(JSON.stringify({ok:false,error_count:errors.length,errors}, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ok:true,declaration_count:declarations.size,catalog_tool_count:catalogNames.length,runner_only_count:[...declarations.values()].filter((x)=>x.consumers.length===1&&x.consumers[0]==="runner").length}, null, 2));
