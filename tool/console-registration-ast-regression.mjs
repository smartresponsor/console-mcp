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

  console.log(JSON.stringify({
    ok: true,
    status: "CONSOLE_REGISTRATION_AST_REGRESSION_GREEN",
    registeredNameCount: scan.registeredNames.length,
    unresolvedCount: scan.unresolved.length,
  }));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
