import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJsonSha256, deliverJsonArtifact } from "../dist/service/json-transport.js";

const artifact = { schemaVersion: "1.0", batchId: "2026-11-02-linkedin-daily-test", actions: [] };

test("JSON transport delivers once and is idempotent", async () => {
  const inbox = await mkdtemp(path.join(tmpdir(), "cmcp-json-inbox-"));
  try {
    const input = { destination: "linkedin-mcp/inbox", artifact, expectedSha256: canonicalJsonSha256(artifact) };
    const first = await deliverJsonArtifact(input, { "linkedin-mcp/inbox": { inboxPath: inbox } });
    const second = await deliverJsonArtifact(input, { "linkedin-mcp/inbox": { inboxPath: inbox } });
    assert.equal(first.status, "TRANSPORT_DELIVERED");
    assert.equal(second.status, "TRANSPORT_ALREADY_DELIVERED");
    assert.deepEqual(JSON.parse(await readFile(path.join(inbox, artifact.batchId + ".json"), "utf8")), artifact);
    assert.deepEqual(await readdir(inbox), [artifact.batchId + ".json"]);
  } finally { await rm(inbox, { recursive: true, force: true }); }
});
test("JSON transport rejects invalid hash, unknown destination and collisions", async () => {
  const inbox = await mkdtemp(path.join(tmpdir(), "cmcp-json-inbox-"));
  const registry = { "linkedin-mcp/inbox": { inboxPath: inbox } };
  try {
    const input = { destination: "linkedin-mcp/inbox", artifact, expectedSha256: canonicalJsonSha256(artifact) };
    await assert.rejects(() => deliverJsonArtifact({ ...input, expectedSha256: "0".repeat(64) }, registry), /HASH_MISMATCH/);
    await assert.rejects(() => deliverJsonArtifact({ ...input, destination: "../../other" }, registry), /DESTINATION_UNKNOWN/);
    await deliverJsonArtifact(input, registry);
    const other = { ...artifact, actions: [{ type: "follow" }] };
    await assert.rejects(() => deliverJsonArtifact({ ...input, artifact: other, expectedSha256: canonicalJsonSha256(other) }, registry), /BATCH_COLLISION/);
  } finally { await rm(inbox, { recursive: true, force: true }); }
});
