import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { readTextFile } from "../Infrastructure/FileSystem/SafeFileSystem.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const documentMap = {
  "chatgpt-browser-product-loop": "docs/agents/chatgpt-browser-product-loop.md",
  capabilities: "docs/tools/capabilities.md",
  "decision-action-contract": "docs/agents/decision-action-contract.md",
} as const;

const documentNameSchema = z.enum([
  "chatgpt-browser-product-loop",
  "capabilities",
  "decision-action-contract",
]);

export function registerOrchestrationDocsTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.orchestration.docs.bundle",
    {
      description: "Read known orchestration responsibility and capability documents without passing filesystem paths.",
      inputSchema: z.object({
        documents: z.array(documentNameSchema).min(1).max(10).default([
          "chatgpt-browser-product-loop",
          "capabilities",
          "decision-action-contract",
        ]),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ documents }) => textResult(await readOrchestrationDocs(policy, baseDir, documents))
  );
}

async function readOrchestrationDocs(policy: ConsolePolicy, baseDir: string, documents: Array<keyof typeof documentMap>): Promise<{
  ok: true;
  documents: Array<{ name: keyof typeof documentMap; path: string; sizeBytes: number; content: string }>;
}> {
  const output = [];
  for (const name of documents) {
    const relativePath = documentMap[name];
    const file = await readTextFile(policy, path.join(baseDir, relativePath));
    output.push({ name, path: relativePath, sizeBytes: file.sizeBytes, content: file.content });
  }

  return { ok: true, documents: output };
}
