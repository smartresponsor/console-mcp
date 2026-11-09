import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJsonSha256, deliverJsonArtifact } from "../dist/service/json-transport.js";

const root = await mkdtemp(path.join(os.tmpdir(), "console-transport-test-"));
const registry = { "test/inbox": { inboxPath: root, fileMode: 384 } };
const artifact = { batchId: "transport_sprint1_fixture", kind: "connectivity-test", data: { value: 1 } };
const sha = canonicalJsonSha256(artifact);
const send = (payload, expectedSha256 = sha) => deliverJsonArtifact(
  { destination: "test/inbox", artifact: payload, expectedSha256 }, registry,
);
try {
  const first = await send(artifact);
  assert.equal(first.status, "TRANSPORT_DELIVERED");
  assert.equal(first.sha256, sha);
  const disk = await readFile(path.join(root, artifact.batchId + ".json"), "utf8");
  assert.equal(disk, JSON.stringify(artifact, null, 2) + "\n");
  const second = await send(artifact);
  assert.equal(second.status, "TRANSPORT_ALREADY_DELIVERED");
  assert.equal(second.sha256, sha);
  await assert.rejects(send({ ...artifact, data: { value: 2 } }, canonicalJsonSha256({ ...artifact, data: { value: 2 } })), /TRANSPORT_BATCH_COLLISION/);
  await assert.rejects(send(artifact, "0".repeat(64)), /TRANSPORT_HASH_MISMATCH/);
  await assert.rejects(deliverJsonArtifact({ destination: "linkedin-mcp/inbox", artifact, expectedSha256: sha }, registry), /TRANSPORT_DESTINATION_UNKNOWN/);
  const after = await readFile(path.join(root, artifact.batchId + ".json"), "utf8");
  assert.equal(after, disk);
  console.log(JSON.stringify({ ok: true, first: first.status, repeated: second.status, collision: "rejected", invalidHash: "rejected", externalDestination: "rejected", sha256: sha }));
} finally {
  await rm(root, { recursive: true, force: true });
}
