import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanConsoleRegistrations } from "./console-registration-ast.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "console-registration-ast-"));
try {
  const toolDir = path.join(tempRoot, "src", "tool");
  await mkdir(toolDir, { recursive: true });
  await writeFile(path.join(toolDir, "fixture.ts"), `
const decoy = "read_.fake.decoy";

export function registerFixture(server: any, unresolvedName: string): void {
  server.registerTool("read_.real.literal", {}, async () => ({}));
  registerParameterized(server, "read_.real.parameterized");
  for (const alias of [
    { name: "write.real.loop.one" },
    { name: "write.real.loop.two" },
  ] as const) {
    server.registerTool(alias.name, {}, async () => ({}));
  }
  server.registerTool(unresolvedName, {}, async () => ({}));
}

function registerParameterized(server: any, name: string): void {
  server.registerTool(name, {}, async () => ({}));
}
`, "utf8");

  await writeFile(path.join(tempRoot, "src", "index.ts"), 'import { registerFixture } from "./tool/fixture.js"; registerFixture(server);');
  const scan = await scanConsoleRegistrations(tempRoot);
  assert.deepEqual(scan.registeredNames, [
    "read_.real.literal",
    "read_.real.parameterized",
    "write.real.loop.one",
    "write.real.loop.two",
  ]);
  assert.equal(scan.registeredNames.includes("read_.fake.decoy"), false, "unregistered string literal must not count as registration");
  assert.equal(scan.unresolved.length, 1, "unknown dynamic registration must remain unresolved and fail closed");
  assert.match(scan.unresolved[0].reason, /unresolvedName/);

  // Unwired and type-only modules must not become advertised capabilities.
  await writeFile(path.join(toolDir, "draft.ts"), 'export type Draft = string; server.registerTool("read_.staged", {}, handler);');
  await writeFile(path.join(tempRoot, "src", "index.ts"), 'import "./tool/fixture.js"; import type { Draft } from "./tool/draft.js";');
  assert.equal((await scanConsoleRegistrations(tempRoot)).registeredNames.includes("read_.staged"), false);
  // Naming does not grant an exemption: wiring a draft into runtime exposes it.
  for (const statement of [
    'import "./tool/draft.js";',
    'export * from "./tool/draft.js";',
    'void import("./tool/draft.js");',
    'require("./tool/draft.js");',
  ]) {
    await writeFile(path.join(tempRoot, "src", "index.ts"), statement);
    assert.deepEqual((await scanConsoleRegistrations(tempRoot)).registeredNames, ["read_.staged"]);
  }
  await writeFile(path.join(tempRoot, "src", "index.ts"), 'import "./tool/missing.js";');
  await assert.rejects(scanConsoleRegistrations(tempRoot), /Unresolved runtime import/);

  console.log(JSON.stringify({
    ok: true,
    status: "CONSOLE_REGISTRATION_AST_REGRESSION_GREEN",
    registeredNameCount: scan.registeredNames.length,
    unresolvedCount: scan.unresolved.length,
  }));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
