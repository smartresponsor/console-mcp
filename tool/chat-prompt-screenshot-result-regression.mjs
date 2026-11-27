import assert from "node:assert/strict";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { prepareChatPromptScreenshot, inspectChatPromptScreenshotPng } from "../dist/engine/chat-prompt-screenshot.js";
import { chatPromptScreenshotResult } from "../dist/engine/chat-prompt-screenshot-result.js";
import { makePng } from "./chat-prompt-screenshot-png-fixture.mjs";
const url = "https://chatgpt.com/s/t_0123456789abcdef0123456789abcdef";
const plan = prepareChatPromptScreenshot(url);
const png = makePng(1110, 7200);
const metadata = inspectChatPromptScreenshotPng(png, { x: 0, y: 0, width: 370, height: 2400 });
const result = CallToolResultSchema.parse(chatPromptScreenshotResult({ plan, png, metadata }));
assert.equal(result.structuredContent.ok, true);
assert.equal(result.content.length, 2);
assert.equal(result.content[1].type, "image");
assert.equal(result.content[1].mimeType, "image/png");
assert.deepEqual(Buffer.from(result.content[1].data, "base64"), png);
assert.equal(result.content[0].text.includes(url), false);
assert.equal(result.content[0].text.includes(png.toString("base64")), false);
assert.equal(result.structuredContent.artifact.sha256, metadata.sha256);
assert.equal(result.structuredContent.artifact.bytes, png.length);
for (const bad of [{ png: Buffer.from([0]) }, { metadata: { ...metadata, sha256: "0".repeat(64) } }]) {
  const failure = CallToolResultSchema.parse(chatPromptScreenshotResult({ plan, png, metadata, ...bad }));
  assert.equal(failure.isError, true);
  assert.equal(failure.content.some(x => x.type === "image"), false);
}
console.log("chat prompt screenshot MCP image result regression: PASS (synthetic PNG; SDK schema only)");
