import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPdfArtifact } from "../src/service/web-artifact-import.ts";
const root = await mkdtemp(join(tmpdir(), "web-artifact-import-"));
const bytes = Buffer.from("%PDF-1.4\n%%EOF\n");
const encoded = bytes.toString("base64");
const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
try {
  const result = await importPdfArtifact({ encoded, filename: "resume.pdf", expectedSha256, uploadRoot: root });
  assert.equal(result.sha256, expectedSha256);
  assert.deepEqual(await readFile(join(root, result.artifactRef)), bytes);
  await assert.rejects(importPdfArtifact({ encoded, filename: "../escape.pdf", expectedSha256, uploadRoot: root }), /FILENAME_INVALID/);
  await assert.rejects(importPdfArtifact({ encoded, filename: "resume.pdf", expectedSha256: "a".repeat(64), uploadRoot: root }), /HASH_MISMATCH/);
  await assert.rejects(importPdfArtifact({ encoded: Buffer.from("fake").toString("base64"), filename: "resume.pdf", expectedSha256, uploadRoot: root }), /TYPE_INVALID/);
  console.log("WEB_ARTIFACT_IMPORT_GREEN");
} finally { await rm(root, { recursive: true, force: true }); }
