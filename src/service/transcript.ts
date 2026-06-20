import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { normalizePath } from "./policy.js";

export async function readLatestBuildCommand(transcriptDir: string): Promise<string | null> {
  const dir = normalizePath(transcriptDir);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        const fileStat = await stat(filePath);
        return { filePath, mtimeMs: fileStat.mtimeMs };
      }));

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const { filePath } of files) {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as { checkName?: string; command?: string; args?: string[] };
      const command = formatCommand(parsed.command, parsed.args ?? []);
      if (/^(npm|composer|php)\b/i.test(command) && /(build|test|validate|cache:clear|diff)/i.test(command)) {
        return command;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function formatCommand(command?: string, args: string[] = []): string {
  if (!command) {
    return "";
  }

  return [command, ...args].join(" ").trim();
}
