import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";
import { importPdfArtifact } from "../service/web-artifact-import.js";

export const webArtifactImportToolName = "write.web.artifact.import";

export function registerWebArtifactImportTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool(webArtifactImportToolName, {
    description: "Import an explicitly approved, SHA256-verified PDF into the dedicated browser upload root, returning a relative artifactRef. Never submits a form.",
    inputSchema: z.object({
      approved: z.literal(true),
      approvalText: z.literal("IMPORT"),
      filename: z.string().min(1).max(132),
      encoded: z.string().min(1).max(8 * 1024 * 1024),
      expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    }).strict(),
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async input => {
    // Never accept a caller-specified upload root, URL, or local file path.
    const root = process.env.BROWSER_MCP_UPLOAD_ROOT?.trim();
    if (!root || !root.startsWith("/var/lib/console-mcp-upload/")) {
      return textResult({ ok: false, status: "WEB_ARTIFACT_IMPORT_NOT_CONFIGURED" });
    }
    try {
      const imported = await importPdfArtifact({ ...input, uploadRoot: root });
      return textResult({ ok: true, status: "WEB_ARTIFACT_IMPORTED", ...imported });
    } catch (error) {
      const message = error instanceof Error ? error.message : "WEB_ARTIFACT_IMPORT_FAILED";
      return textResult({ ok: false, status: message.startsWith("WEB_ARTIFACT_") ? message : "WEB_ARTIFACT_IMPORT_FAILED" });
    }
  });
}
