import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";
import { deliverJsonArtifact, type JsonDestinationRegistry } from "../service/json-transport.js";
import { readFile } from "node:fs/promises";

const registrationName = "write.transport.json.artifact";
const registryPath = new URL("../../policy/json-transport-destinations.json", import.meta.url);

export function registerJsonTransportTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool(registrationName, {
    description: "Deliver a SHA256-verified JSON artifact to a registered recipient inbox. Only the destination alias is caller-controlled; absolute paths are fixed by trusted configuration. Does not execute the artifact.",
    inputSchema: z.object({
      destination: z.string().min(1).max(100),
      artifact: z.record(z.string(), z.unknown()),
      expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    }).strict(),
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async input => {
    try {
      const registry = JSON.parse(await readFile(registryPath, "utf8")) as JsonDestinationRegistry;
      return textResult(await deliverJsonArtifact(input, registry));
    } catch (error) {
      const message = error instanceof Error ? error.message : "TRANSPORT_UNKNOWN_FAILURE";
      return textResult({ ok: false, status: message.startsWith("TRANSPORT_") ? message : "TRANSPORT_DELIVERY_FAILED" });
    }
  });
}
