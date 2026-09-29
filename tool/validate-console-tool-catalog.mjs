import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanConsoleRegistrations } from "./console-registration-ast.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const readText = (relative) => readFile(path.join(root, relative), "utf8");
const readJson = async (relative) => {
  try {
    return JSON.parse(await readText(relative));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${relative}: ${message}`);
  }
};

const canonicalPattern = /^(read_|write)\.[a-z0-9_]+(?:\.[a-z0-9_]+){2,}$/;
const isCanonical = (name) => /^(read_|write)\./.test(name);
const addError = (message) => errors.push(message);

const index = await readJson("policy/console-tool-catalog-index.json");
if (index.rootNamespace !== "none") addError("catalog index rootNamespace must be none");
if (!Array.isArray(index.fragments)) addError("catalog index fragments must be an array");

const policyCanonical = new Map();
const policyLegacy = new Set();
const policyLegacyOwner = new Map();
for (const fragmentPath of index.fragments ?? []) {
  const fragment = await readJson(fragmentPath);
  if (fragment.rootNamespace !== "none") addError(`${fragmentPath}: rootNamespace must be none`);
  for (const tool of fragment.tools ?? []) {
    if (typeof tool.legacyName === "string") {
      policyLegacy.add(tool.legacyName);
      policyLegacyOwner.set(tool.legacyName, { fragmentPath, canonicalName: tool.canonicalName });
      if (!canonicalPattern.test(tool.legacyName)) addError(`${fragmentPath}: invalid legacy name ${tool.legacyName}`);
      if (tool.legacyName.split(".")[0] !== tool.risk) addError(`${fragmentPath}: ${tool.legacyName} risk token does not match risk=${tool.risk}`);
    }
    const names = [tool.canonicalName, ...(tool.canonicalReadAliases ?? [])].filter(Boolean);
    for (const name of names) {
      if (!canonicalPattern.test(name)) addError(`${fragmentPath}: invalid canonical name ${name}`);
      const riskToken = name.split(".")[0];
      if (name === tool.canonicalName && riskToken !== tool.risk) addError(`${fragmentPath}: ${name} risk token does not match risk=${tool.risk}`);
      const existing = policyCanonical.get(name);
      if (existing && existing.fragmentPath !== fragmentPath) {
        addError(`${fragmentPath}: canonical name ${name} already owned by ${existing.fragmentPath}`);
      } else if (existing && (existing.tool.legacyName !== tool.legacyName || existing.tool.risk !== tool.risk)) {
        addError(`${fragmentPath}: conflicting canonical name ${name}`);
      }
      if (!existing) policyCanonical.set(name, { fragmentPath, tool });
    }
  }
}

const catalogText = await readText("src/tool/catalog.ts");
const catalogNames = [...catalogText.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const catalogCanonical = catalogNames.filter(isCanonical);

const toolDir = path.join(root, "src/tool");
const toolFiles = (await readdir(toolDir)).filter((name) => name.endsWith(".ts"));
const sourceFiles = [];
for (const file of toolFiles) sourceFiles.push({ file, text: await readFile(path.join(toolDir, file), "utf8") });
const registrationScan = await scanConsoleRegistrations(root);
const registeredCanonical = new Set(registrationScan.registeredNames);
const registeredLegacyPairs = new Map(
  registrationScan.legacyPairs.map((pair) => [pair.legacy, pair.canonical]),
);
for (const item of registrationScan.unresolved) {
  addError(`unresolved dynamic registration at ${item.file}:${item.line}: ${item.call}: ${item.reason}`);
}

for (const name of policyCanonical.keys()) {
  const tool = policyCanonical.get(name).tool;
  const planned = tool.registrationStatus === "planned" || tool.runtimeStatus === "planned";
  if (!registeredCanonical.has(name) && !planned) addError(`policy canonical name is not registered: ${name}`);
}

for (const name of registeredCanonical) {
  if (!policyCanonical.has(name) && !policyLegacy.has(name)) addError(`registered canonical or legacy name is missing from policy: ${name}`);
}

for (const name of catalogCanonical) {
  if (!policyCanonical.has(name) && !policyLegacy.has(name)) addError(`src/tool/catalog.ts canonical or legacy name is missing from policy: ${name}`);
  if (!registeredCanonical.has(name)) addError(`src/tool/catalog.ts canonical or legacy name is not registered: ${name}`);
}

for (const name of policyLegacy) {
  if (!catalogNames.includes(name)) addError(`legacy policy name is missing from src/tool/catalog.ts: ${name}`);
  if (!registeredCanonical.has(name)) addError(`legacy policy name is not registered: ${name}`);
  const owner = policyLegacyOwner.get(name);
  if (owner && registeredLegacyPairs.get(name) !== owner.canonicalName) {
    addError(`${owner.fragmentPath}: legacy name ${name} must share registration with canonical ${owner.canonicalName}`);
  }
}

const directRegistrationPattern = /server\.registerTool\(\s*["']((?:read_|write)\.[^"']+)["']\s*,\s*\{([\s\S]*?)\}\s*,\s*async\b/g;
for (const sourceFile of sourceFiles) {
  const mutationRegistrationVariables = new Set(
    [...sourceFile.text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*buildConsoleMutationToolRegistration\s*\(/g)].map((match) => match[1]),
  );
  for (const match of sourceFile.text.matchAll(directRegistrationPattern)) {
    const name = match[1];
    const body = match[2];
    const spreadVariables = [...body.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].map((spread) => spread[1]);
    const usesMutation = /buildConsoleMutationToolRegistration\s*\(/.test(body)
      || spreadVariables.some((variable) => mutationRegistrationVariables.has(variable));
    const policy = policyCanonical.get(name)?.tool;
    if (name.startsWith("write.") && !usesMutation) addError(`write alias does not use mutation registration: ${name}`);
    if (name.startsWith("read_.") && usesMutation && policy?.allowMutationRegistration !== true) addError(`read alias unexpectedly uses mutation registration: ${name}`);
  }
}

const commonToolSource = await readText("src/tool/common.ts");
if (!commonToolSource.includes("outputSchema: consoleToolOutputSchema")) {
  addError("shared console tool registration does not advertise outputSchema");
}
if (!commonToolSource.includes("structuredContent")) {
  addError("shared console tool result does not return structuredContent");
}
if (!commonToolSource.includes(".passthrough()")) {
  addError("shared console output schema must preserve existing tool-specific fields during migration");
}

if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, error_count: errors.length, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  fragment_count: index.fragments.length,
  policy_canonical_count: policyCanonical.size,
  registered_canonical_count: registeredCanonical.size,
  catalog_tool_count: catalogNames.length,
}, null, 2));
