import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";
import { requestReleaseBroker, requestReleaseTransactionBroker } from "../service/release-broker-client.js";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const transactionIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

export function registerReleaseBrokerTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("read_.release.runtime.status", {
    description: "Read the independently privileged Ubuntu release broker's status, selected immutable candidate and rollback; never changes runtime.",
    inputSchema: z.object({ runId: z.string().regex(/^[0-9a-f]{32}$/).optional() }).strict(),
    ...buildConsoleToolRegistration(authConfig),
  }, async ({ runId }) => textResult(await requestReleaseBroker("status", undefined, runId)));

  for (const entry of [
    { name: "write.release.artifact.prepare", operation: "prepare", note: "Seals an exact master commit without switching runtime." },
    { name: "write.release.artifact.validate", operation: "validate", note: "Runs independent candidate and rollback proof without activating." },
  ] as const) {
    server.registerTool(entry.name, {
      description: entry.note + " Requires exact SHA and explicit confirmation; authorization, lock and gates are owned by the root release broker.",
      inputSchema: z.object({ sha: shaSchema, confirm: z.boolean().default(false) }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    }, async ({ sha, confirm }) => textResult(confirm
      ? await requestReleaseBroker(entry.operation, sha)
      : { ok: false, status: "RELEASE_EXPLICIT_CONFIRMATION_REQUIRED", operation: entry.operation, sha }));
  }

  for (const entry of [
    { name: "write.release.runtime.activate", operation: "activate" },
    { name: "write.release.runtime.rollback", operation: "rollback" },
  ] as const) {
    server.registerTool(entry.name, {
      description: "Compatibility release runtime entrypoint. Requires an exact broker transaction ID and explicit confirmation; SHA-only cutover is refused.",
      inputSchema: z.object({ transactionId: transactionIdSchema, confirm: z.boolean().default(false) }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    }, async ({ transactionId, confirm }) => textResult(confirm
      ? await requestReleaseTransactionBroker({ operation: entry.operation, transactionId, confirmed: true })
      : confirmationRequired(entry.operation, transactionId)));
  }

  server.registerTool("read_.release.transaction.status", {
    description: "Read one exact root-broker release transaction and its durable phase evidence; never changes runtime.",
    inputSchema: z.object({ transactionId: transactionIdSchema }).strict(),
    ...buildConsoleToolRegistration(authConfig),
  }, async ({ transactionId }) => textResult(await requestReleaseTransactionBroker({ operation: "status", transactionId })));

  server.registerTool("write.release.transaction.prepare", {
    description: "Create one root-broker transaction for an exact immutable release SHA without switching runtime.",
    inputSchema: z.object({ sha: shaSchema, confirm: z.boolean().default(false) }).strict(),
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async ({ sha, confirm }) => textResult(confirm
    ? await requestReleaseTransactionBroker({ operation: "prepare", sha, confirmed: true })
    : confirmationRequired("prepare")));

  for (const entry of [
    { name: "write.release.transaction.validate", operation: "validate", note: "Validate candidate, rollback and continuity evidence for one prepared transaction." },
    { name: "write.release.transaction.activate", operation: "activate", note: "Activate one exactly identified validated transaction through the privileged broker." },
    { name: "write.release.transaction.rollback", operation: "rollback", note: "Roll back one exactly identified activation through the privileged broker." },
  ] as const) {
    server.registerTool(entry.name, {
      description: entry.note + " Requires the exact transaction ID and explicit confirmation; protected broker policy and controller gates remain authoritative.",
      inputSchema: z.object({ transactionId: transactionIdSchema, confirm: z.boolean().default(false) }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    }, async ({ transactionId, confirm }) => textResult(confirm
      ? await requestReleaseTransactionBroker({ operation: entry.operation, transactionId, confirmed: true })
      : confirmationRequired(entry.operation, transactionId)));
  }
}

function confirmationRequired(operation: string, transactionId?: string): Record<string, unknown> {
  return { ok: false, status: "RELEASE_EXPLICIT_CONFIRMATION_REQUIRED", operation, transactionId: transactionId ?? null };
}
