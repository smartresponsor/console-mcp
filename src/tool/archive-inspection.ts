import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { assertReadablePath } from "../Policy/PathGuard.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const run = promisify(execFile);
async function source(policy: ConsolePolicy, candidate: string): Promise<string> {
  const checked = assertReadablePath(candidate, policy.deniedPath, policy.allowedRoots);
  const canonical = await realpath(checked);
  assertReadablePath(canonical, policy.deniedPath, policy.allowedRoots);
  if (!(await stat(canonical)).isFile()) throw new Error("Not a regular file");
  return canonical;
}
export function registerArchiveInspectionTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool("read_.file.inspect", {
    description: "Inspect file metadata and optional SHA-256 inside allowed roots.",
    inputSchema: z.object({ filePath: z.string().min(1), sha256: z.boolean().default(false) }).strict(),
    ...buildConsoleToolRegistration(authConfig),
  }, async ({ filePath, sha256 }) => {
    const file = await source(policy, filePath);
    const info = await stat(file);
    let digest: string | undefined;
    if (sha256) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      digest = hash.digest("hex");
    }
    return textResult({ ok: true, path: file, sizeBytes: info.size, modifiedAt: info.mtime.toISOString(), sha256: digest });
  });
  server.registerTool("read_.archive.inspect", {
    description: "List ZIP entries without extracting, and flag unsafe entry paths.",
    inputSchema: z.object({ archivePath: z.string().min(1) }).strict(),
    ...buildConsoleToolRegistration(authConfig),
  }, async ({ archivePath }) => {
    const file = await source(policy, archivePath);
    if (!file.toLowerCase().endsWith(".zip")) throw new Error("Only ZIP supported");
    const { stdout } = await run("unzip", ["-Z", "-1", file], { timeout: 30000, maxBuffer: 1048576 });
    const entries = stdout.split(/\r?\n/).filter(Boolean);
    const unsafeEntries = entries.filter((entry) => entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes(".."));
    return textResult({ ok: unsafeEntries.length === 0, path: file, entryCount: entries.length, entries: entries.slice(0, 1000), truncated: entries.length > 1000, unsafeEntries });
  });
  server.registerTool("read_.archive.verify", {
    description: "Verify ZIP archive CRC without extracting.",
    inputSchema: z.object({ archivePath: z.string().min(1) }).strict(),
    ...buildConsoleToolRegistration(authConfig),
  }, async ({ archivePath }) => {
    const file = await source(policy, archivePath);
    if (!file.toLowerCase().endsWith(".zip")) throw new Error("Only ZIP supported");
    try {
      const { stdout } = await run("unzip", ["-t", "-q", file], { timeout: 120000, maxBuffer: 1048576 });
      return textResult({ ok: true, path: file, summary: stdout.trim().slice(-1000) });
    } catch (error) {
      return textResult({ ok: false, path: file, error: String(error).slice(0, 1000) });
    }
  });
}
