import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";
import { requestReleaseBroker } from "../service/release-broker-client.js";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export function registerReleaseBrokerTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("read_.release.runtime.status", {
    description: "Read the independently privileged Ubuntu release broker's status, selected immutable candidate and rollback; never changes runtime.",
    inputSchema: z.object({ runId: z.string().regex(/^[0-9a-f]{32}$/).optional() }).strict(),
    ...buildConsoleToolRegistration(authConfig),
  }, async ({ runId }) => textResult(await requestReleaseBroker("status", undefined, runId)));

  for (const entry of [
    { name: "write.release.artifact.prepare", operation: "prepare", note: "Seals an exact master commit without switching runtime." },
    { name: "write.release.artifact.validate", operation: "validate", note: "Runs independent candidate and rollback proof without activating." },
    { name: "write.release.runtime.activate", operation: "activate", note: "Requests privileged serialized cutover only when root-owned activation policy allows it." },
    { name: "write.release.runtime.rollback", operation: "rollback", note: "Requests privileged rollback only when root-owned activation policy allows it." },
  ] as const) {
    server.registerTool(entry.name, {
      description: entry.note + " Requires exact SHA and explicit confirmation; authorization, lock and gates are owned by the root release broker.",
      inputSchema: z.object({ sha: shaSchema, confirm: z.boolean().default(false) }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    }, async ({ sha, confirm }) => textResult(confirm
      ? await requestReleaseBroker(entry.operation, sha)
      : { ok: false, status: "RELEASE_EXPLICIT_CONFIRMATION_REQUIRED", operation: entry.operation, sha }));
  }
}
