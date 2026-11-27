import assert from "node:assert/strict";
import { makePng } from "./chat-prompt-screenshot-png-fixture.mjs";
import {
  CHAT_PROMPT_SCREENSHOT_CAPABILITY, prepareChatPromptScreenshot,
  resolveChatPromptScreenshotBounds, inspectChatPromptScreenshotPng,
} from "../src/engine/chat-prompt-screenshot.ts";

const url = "https://chatgpt.com/s/t_0123456789abcdef0123456789abcdef";
const day = new Date("2026-11-26T13:00:00Z");
const night = new Date("2026-11-27T01:00:00Z");
assert.equal(CHAT_PROMPT_SCREENSHOT_CAPABILITY, "write.engine.chat.prompt.screenshot");
assert.equal(prepareChatPromptScreenshot(url, day).theme, "light");
assert.equal(prepareChatPromptScreenshot(url, night).theme, "dark");
assert.equal(prepareChatPromptScreenshot(url, night, "light").theme, "light");
assert.equal(prepareChatPromptScreenshot(url, day).device.deviceScaleFactor, 3);
assert.equal(prepareChatPromptScreenshot(url, day).target, "shared_message");
for (const invalid of [url+"\n", url+"?x=1", url+"/other", url.replace("https:", "http:"),
  url.replace("chatgpt.com", "chatgpt.com.evil.example"), "https://chatgpt.com/c/abc"]) {
  assert.throws(() => prepareChatPromptScreenshot(invalid, day), /URL_INVALID/);
}
const bounds = { x: 10, y: 300, width: 370, height: 2400 };
const evidence = { url, ready: true, candidateCount: 1, exactSharedMessage: true, bounds };
assert.deepEqual(resolveChatPromptScreenshotBounds(url, evidence), { ...bounds, scale: 1, captureBeyondViewport: true });
for (const change of [{ candidateCount: 0 }, { candidateCount: 2 }, { ready: false },
  { exactSharedMessage: false }, { url: url.replace(/.$/, "0") }]) {
  assert.throws(() => resolveChatPromptScreenshotBounds(url, { ...evidence, ...change }), /TARGET_UNVERIFIED/);
}
assert.throws(() => resolveChatPromptScreenshotBounds(url, { ...evidence, bounds: { ...bounds, width: 394 } }), /BOUNDS_INVALID/);
assert.throws(() => resolveChatPromptScreenshotBounds(url, { ...evidence, bounds: { ...bounds, x: 24 } }), /BOUNDS_INVALID/);
assert.throws(() => resolveChatPromptScreenshotBounds(url, { ...evidence, bounds: { ...bounds, height: 20000 } }), /SIZE_LIMIT/);
const png = makePng(1110, 7200);
assert.equal(inspectChatPromptScreenshotPng(png, bounds).height, 7200);
assert.equal(inspectChatPromptScreenshotPng(makePng(1110, 7200, 4, 6), bounds).width, 1110);
for (const invalid of [Buffer.alloc(33), png.subarray(0, 33), png.subarray(0, -12), Buffer.concat([png, Buffer.from([0])]), makePng(1110, 7200, 5)]) {
  assert.throws(() => inspectChatPromptScreenshotPng(invalid, bounds), /PNG_INVALID/);
}
const crcBroken = Buffer.from(png); crcBroken[45] ^= 1;
assert.throws(() => inspectChatPromptScreenshotPng(crcBroken, bounds), /PNG_INVALID/);
assert.throws(() => inspectChatPromptScreenshotPng(makePng(1110, 2556), bounds), /DIMENSIONS_MISMATCH/);
console.log("chat prompt screenshot contract regression: PASS");
