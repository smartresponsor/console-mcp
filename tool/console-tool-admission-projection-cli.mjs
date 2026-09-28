import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectConsoleToolAdmission, stableAdmissionJson } from "./console-tool-admission-projection.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "policy", "console-tool-admission.json");
const projected = await projectConsoleToolAdmission(root);
const projectedText = stableAdmissionJson(projected);
const mode = process.argv[2] ?? "--check";

if (mode === "--write") {
  await fs.writeFile(target, projectedText, "utf8");
  console.log(JSON.stringify({ ok: true, status: "CONSOLE_TOOL_ADMISSION_PROJECTED", declarationCount: projected.declarations.length }));
  process.exit(0);
}

if (mode !== "--check") {
  console.error("usage: node tool/console-tool-admission-projection-cli.mjs [--check|--write]");
  process.exit(2);
}

const current = JSON.parse(await fs.readFile(target, "utf8"));
const currentComparable = {
  schemaVersion: current.schemaVersion,
  id: current.id,
  status: current.status,
  generatedFrom: current.generatedFrom,
  declarations: current.declarations,
};
const projectedComparable = {
  schemaVersion: projected.schemaVersion,
  id: projected.id,
  status: projected.status,
  generatedFrom: projected.generatedFrom,
  declarations: projected.declarations,
};

if (JSON.stringify(currentComparable) !== JSON.stringify(projectedComparable)) {
  console.error(JSON.stringify({
    ok: false,
    status: "CONSOLE_TOOL_ADMISSION_PROJECTION_DRIFT",
    currentCount: current.declarations?.length ?? 0,
    projectedCount: projected.declarations.length,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  status: "CONSOLE_TOOL_ADMISSION_PROJECTION_GREEN",
  declarationCount: projected.declarations.length,
  overrideCount: Object.keys(JSON.parse(await fs.readFile(path.join(root, "policy", "console-tool-admission-overrides.json"), "utf8")).overrides ?? {}).length,
}));
