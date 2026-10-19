import { createHash, randomUUID } from "node:crypto";
import { chmod, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

export type ImportedWebArtifact = { artifactRef: string; sha256: string; size: number; mime: "application/pdf" };

export async function importPdfArtifact(input: {
  encoded: string; filename: string; expectedSha256: string; uploadRoot: string;
}): Promise<ImportedWebArtifact> {
  const { encoded, filename, expectedSha256, uploadRoot } = input;
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256)) throw new Error("WEB_ARTIFACT_HASH_REQUIRED");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.pdf$/i.test(filename) || basename(filename) !== filename ||
    filename === "." || filename === "..") throw new Error("WEB_ARTIFACT_FILENAME_INVALID");
  if (typeof encoded !== "string" || encoded.length > 8 * 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error("WEB_ARTIFACT_ENCODING_INVALID");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) throw new Error("WEB_ARTIFACT_SIZE_INVALID");
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("WEB_ARTIFACT_TYPE_INVALID");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256.toLowerCase()) throw new Error("WEB_ARTIFACT_HASH_MISMATCH");
  // The directory must be provisioned by deployment; never create an arbitrary root.
  const root = await realpath(resolve(uploadRoot));
  const name = randomUUID() + "-" + filename;
  const target = join(root, name);
  if (!target.startsWith(root + sep)) throw new Error("WEB_ARTIFACT_PATH_INVALID");
  const temp = join(root, "." + randomUUID() + ".partial");
  const handle = await open(temp, "wx", 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await chmod(temp, 0o640);
    await rename(temp, target);
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  return { artifactRef: name, sha256, size: bytes.length, mime: "application/pdf" };
}
