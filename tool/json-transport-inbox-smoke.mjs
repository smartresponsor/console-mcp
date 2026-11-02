import { canonicalJsonSha256, deliverJsonArtifact } from "../dist/service/json-transport.js";
import { readFile } from "node:fs/promises";
const registry = JSON.parse(await readFile(new URL("../policy/json-transport-destinations.json", import.meta.url), "utf8"));
const artifact = {
  schemaVersion: "1.0",
  batchId: "2026-11-02-linkedin-transport-shared-smoke",
  generatedAt: "2026-11-02T04:54:00-06:00",
  source: "chatgpt-daily-discovery",
  timezone: "America/Chicago",
  manifest: { totalActions: 0, counts: { comment: 0, follow: 0, connect: 0 } },
  actions: []
};
const result = await deliverJsonArtifact({ destination: "linkedin-mcp/inbox", artifact, expectedSha256: canonicalJsonSha256(artifact) }, registry);
console.log(JSON.stringify(result));
if (!result.ok || !["TRANSPORT_DELIVERED","TRANSPORT_ALREADY_DELIVERED"].includes(result.status)) process.exit(1);
