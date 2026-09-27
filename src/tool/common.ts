import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { z } from "zod";

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export const consoleToolOutputSchema = z.object({
  ok: z.boolean().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
  issues: z.array(z.string()).optional(),
  policy: z.record(z.unknown()).optional(),
}).passthrough();

function normalizeStructuredPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  return {
    ok: true,
    value: payload,
  };
}

export function textResult(payload: unknown): ToolTextResult {
  const structuredContent = normalizeStructuredPayload(payload);

  return {
    structuredContent,
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
  };
}

export function errorResult(message: string, issues: string[] = []): ToolTextResult {
  return textResult({
    ok: false,
    error: message,
    issues,
  });
}

export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, truncated: false };
  }

  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

export function buildConsoleToolRegistration(authConfig: ConsoleAuthConfig): {
  annotations: { readOnlyHint: true };
  outputSchema: typeof consoleToolOutputSchema;
  _meta?: Record<string, unknown>;
} {
  const annotations = { readOnlyHint: true as const };

  if (authConfig.mode !== "oauth") {
    return { annotations, outputSchema: consoleToolOutputSchema };
  }

  return {
    annotations,
    outputSchema: consoleToolOutputSchema,
    _meta: {
      securitySchemes: [
        {
          type: "oauth2",
          scopes: [authConfig.readScope],
        },
      ],
    },
  };
}

export function registerConsoleToolWithLegacyAlias<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
  server: McpServer,
  canonicalName: string,
  legacyName: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  callback: ToolCallback<InputArgs>,
): void {
  server.registerTool(canonicalName, config, callback);
  server.registerTool(legacyName, config, callback);
}

export function buildConsoleMutationToolRegistration(authConfig: ConsoleAuthConfig): {
  annotations: { readOnlyHint: false };
  outputSchema: typeof consoleToolOutputSchema;
  _meta?: Record<string, unknown>;
} {
  const annotations = { readOnlyHint: false as const };

  if (authConfig.mode !== "oauth") {
    return { annotations, outputSchema: consoleToolOutputSchema };
  }

  return {
    annotations,
    outputSchema: consoleToolOutputSchema,
    _meta: {
      securitySchemes: [
        {
          type: "oauth2",
          scopes: [authConfig.writeScope],
        },
      ],
    },
  };
}

