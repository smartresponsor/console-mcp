import type { ConsoleAuthConfig } from "../service/auth.js";

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function textResult(payload: unknown): ToolTextResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
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
  _meta?: Record<string, unknown>;
} {
  const annotations = { readOnlyHint: true as const };

  if (authConfig.mode !== "oauth") {
    return { annotations };
  }

  return {
    annotations,
    _meta: {
      securitySchemes: [
        {
          type: "oauth2",
          scopes: [authConfig.requiredScope],
        },
      ],
    },
  };
}
