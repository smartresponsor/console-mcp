import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = "src/tool/catalog.ts";
const parseNames = (text) => [...text.matchAll(/"(console\.(?:read_|write)\.[^"]+)"/g)].map((match) => match[1]);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

let upstream;
try {
  upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
} catch {
  console.log(JSON.stringify({ ok: true, status: "ADMISSION_DIFF_SKIPPED_NO_UPSTREAM" }));
  process.exit(0);
}

const mergeBase = git("merge-base", "HEAD", upstream);
const currentCatalog = await readFile(path.join(root, catalogPath), "utf8");
let baseCatalog = "";
try {
  baseCatalog = execFileSync("git", ["show", `${mergeBase}:${catalogPath}`], { cwd: root, encoding: "utf8" });
} catch {
  console.error(JSON.stringify({ ok: false, status: "ADMISSION_DIFF_BASELINE_UNAVAILABLE", merge_base: mergeBase, upstream }, null, 2));
  process.exit(1);
}

const manifest = JSON.parse(await readFile(path.join(root, "policy", "console-tool-admission.json"), "utf8"));
const declarations = new Map((manifest.declarations ?? []).map((item) => [item.name, item]));
const base = new Set(parseNames(baseCatalog));
const current = new Set(parseNames(currentCatalog));
const added = [...current].filter((name) => !base.has(name)).sort();
const removed = [...base].filter((name) => !current.has(name)).sort();
const errors = [];

for (const name of added) {
  const declaration = declarations.get(name);
  if (!declaration) {
    errors.push(`new capability has no admission declaration: ${name}`);
    continue;
  }
  if (declaration.lifecycle === "retired") {
    continue;
  }
  if (!["experimental","admitted"].includes(declaration.lifecycle)) {
    errors.push(`new capability has invalid lifecycle ${declaration.lifecycle}: ${name}`);
  }
  if (!Array.isArray(declaration.consumers) || declaration.consumers.length === 0) {
    errors.push(`new capability has no explicit consumers: ${name}`);
  }
  if ((declaration.kind === "recipe" || declaration.kind === "orchestrationControl" || declaration.kind === "runtimeMaintenance")
      && (declaration.consumers.includes("chatgpt") || declaration.consumers.includes("codex"))) {
    errors.push(`new non-capability kind leaks into model discovery: ${name}`);
  }
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, status: "ADMISSION_DIFF_BLOCKED", upstream, merge_base: mergeBase, added, removed, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  status: "ADMISSION_DIFF_GREEN",
  upstream,
  merge_base: mergeBase,
  added_count: added.length,
  removed_count: removed.length,
  added,
  removed,
}, null, 2));
