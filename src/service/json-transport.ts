import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";

export type JsonDestination = { inboxPath: string; fileMode?: number };
export type JsonDestinationRegistry = Record<string, JsonDestination>;
export type JsonTransportInput = { destination: string; artifact: unknown; expectedSha256: string };

const idPattern = /^[a-z0-9][a-z0-9_-]{0,49}\/[a-z0-9][a-z0-9_-]{0,49}$/;
const batchPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const maxBytes = 1024 * 1024;

export async function deliverJsonArtifact(input: JsonTransportInput, registry: JsonDestinationRegistry) {
  if (!idPattern.test(input.destination) || !Object.hasOwn(registry, input.destination)) {
    throw new Error("TRANSPORT_DESTINATION_UNKNOWN");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.expectedSha256)) throw new Error("TRANSPORT_HASH_INVALID");
  if (!input.artifact || typeof input.artifact !== "object" || Array.isArray(input.artifact)) throw new Error("TRANSPORT_JSON_OBJECT_REQUIRED");
  const artifact = input.artifact as Record<string, unknown>;
  if (typeof artifact.batchId !== "string" || !batchPattern.test(artifact.batchId)) throw new Error("TRANSPORT_BATCH_ID_INVALID");
  const bytes = Buffer.from(JSON.stringify(input.artifact, null, 2) + "\n", "utf8");
  if (bytes.length > maxBytes) throw new Error("TRANSPORT_SIZE_EXCEEDED");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== input.expectedSha256.toLowerCase()) throw new Error("TRANSPORT_HASH_MISMATCH");

  const configured = registry[input.destination].inboxPath;
  if (!path.isAbsolute(configured)) throw new Error("TRANSPORT_INBOX_NOT_ABSOLUTE");
  // Provision destinations outside this capability: no creation or traversal of caller paths.
  const root = await realpath(configured);
  if (root !== path.resolve(configured)) throw new Error("TRANSPORT_INBOX_SYMLINK");
  const target = path.join(root, artifact.batchId + ".json");
  try {
    const existing = await readFile(target);
    const current = createHash("sha256").update(existing).digest("hex");
    if (current === sha256) return { ok: true, status: "TRANSPORT_ALREADY_DELIVERED", destination: input.destination, batchId: artifact.batchId, sha256, bytes: bytes.length };
    throw new Error("TRANSPORT_BATCH_COLLISION");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const fileMode = registry[input.destination].fileMode === 432 ? 0o660 : 0o600;
  const temporary = path.join(root, "." + randomUUID() + ".tmp");
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, fileMode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await chmod(temporary, fileMode);
  } finally {
    await handle.close();
  }
  try {
    // Atomic exclusive commit: hard-link prevents overwrite under concurrent transports.
    const { link } = await import("node:fs/promises");
    await link(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const current = createHash("sha256").update(await readFile(target)).digest("hex");
      if (current === sha256) return { ok: true, status: "TRANSPORT_ALREADY_DELIVERED", destination: input.destination, batchId: artifact.batchId, sha256, bytes: bytes.length };
      throw new Error("TRANSPORT_BATCH_COLLISION");
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return { ok: true, status: "TRANSPORT_DELIVERED", destination: input.destination, batchId: artifact.batchId, sha256, bytes: bytes.length };
}

export function canonicalJsonSha256(artifact: unknown): string {
  return createHash("sha256").update(JSON.stringify(artifact, null, 2) + "\n").digest("hex");
}
