import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL("../" + p, import.meta.url), "utf8");
const facadeSource = await read("src/engine/repo-facade-tools.ts");
const catalogSource = await read("src/tool/catalog.ts");
const toolSource = await read("src/tool/isolated-repo-test.ts");
const admission = JSON.parse(await read("policy/console-tool-admission.json"));
const fragment = JSON.parse(await read("policy/console-tool-catalog-write-repo.json"));
const name = "write.repo.test.isolated";

assert.ok(facadeSource.includes('"' + name + '"'), "Repo facade must explicitly publish the command");
assert.match(facadeSource, /Repo facade cannot publish unregistered or unadmitted tools/);
assert.ok(catalogSource.includes('"' + name + '"'), "Canonical tool catalog must include command");
assert.ok(toolSource.includes('server.registerTool("' + name + '"'), "MCP runtime must register command");
const declaration = admission.declarations.filter(item => item.name === name);
assert.equal(declaration.length, 1);
assert.equal(declaration[0].risk, "write");
assert.deepEqual(declaration[0].consumers, ["chatgpt", "codex", "runner"]);
assert.equal(declaration[0].lifecycle, "admitted");
assert.equal(fragment.tools.filter(item => item.canonicalName === name).length, 1);
assert.match(toolSource, /assertApprovedIsolatedTestSha\(sha\)/);
console.log("PASS isolated-repo-facade-regression (catalog + admission + facade + SHA gate)");
