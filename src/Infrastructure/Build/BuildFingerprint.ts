import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function buildDirectoryFingerprint(directoryPath: string): string {
  const files = collectFiles(directoryPath)
    .map((filePath) => path.relative(directoryPath, filePath).split(path.sep).join("/"))
    .sort();
  const hash = crypto.createHash("sha256");

  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(directoryPath, relativePath)));
    hash.update("\0");
  }

  return hash.digest("hex").slice(0, 16);
}

function collectFiles(directoryPath: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}
