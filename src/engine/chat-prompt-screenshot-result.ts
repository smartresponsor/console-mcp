import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { executeChatPromptScreenshot } from "./chat-prompt-screenshot-execution.js";

// MCP image content is independent of the metadata JSON. Never echo the
// shared URL, page text, local path, or base64 into the text transcript.
export function chatPromptScreenshotResult(result: Awaited<ReturnType<typeof executeChatPromptScreenshot>>): CallToolResult {
  const { png, metadata, plan } = result;
  if (!Buffer.isBuffer(png) || png.length === 0 || png.length > 9 * 1024 * 1024 ||
      metadata.mimeType !== "image/png" || createHash("sha256").update(png).digest("hex") !== metadata.sha256) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, status: "CHAT_PROMPT_SCREENSHOT_ARTIFACT_INVALID" }) }],
      structuredContent: { ok: false, status: "CHAT_PROMPT_SCREENSHOT_ARTIFACT_INVALID" } };
  }
  const body = {
    ok: true, status: "CHAT_PROMPT_SCREENSHOT_CAPTURED",
    artifact: { mimeType: "image/png", width: metadata.width, height: metadata.height, sha256: metadata.sha256, bytes: png.length },
    device: plan.device.name, theme: plan.theme, target: plan.target,
  };
  return { structuredContent: body, content: [
    { type: "text", text: JSON.stringify(body) },
    { type: "image", mimeType: "image/png", data: png.toString("base64") },
  ] };
}
