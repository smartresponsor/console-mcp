import assert from "node:assert/strict";
import { makePng } from "./chat-prompt-screenshot-png-fixture.mjs";
import { registerHooks } from "node:module";
// Resolve the production NodeNext .js import to the exact source file for this
// dependency-free test; the normal TypeScript build retains its .js specifier.
const executionSource = new URL("../src/engine/chat-prompt-screenshot-execution.ts", import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === executionSource && specifier === "./chat-prompt-screenshot.js") {
      return nextResolve("./chat-prompt-screenshot.ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { executeChatPromptScreenshot } = await import(executionSource);
hook.deregister();

const url = "https://chatgpt.com/s/t_0123456789abcdef0123456789abcdef";
const bounds = { x: 10, y: 30, width: 370, height: 2400 };
const evidence = { url, ready: true, candidateCount: 1, exactSharedMessage: true, bounds };
const png = makePng(1110, 7200);
function fixture({ changes = [], capture = { data: png.toString("base64") }, verifyFail = 0, disposeFail = false, navigation = {} } = {}) {
  const calls = [];
  let observations = 0, verifies = 0;
  const session = {
    verify: async () => { calls.push(["verify"]); if (++verifies === verifyFail) throw new Error("ADMISSION_LOST"); },
    call: async (method, params) => {
      calls.push([method, params]);
      return method === "Page.captureScreenshot" ? capture : method === "Page.navigate" ? navigation : {};
    },
    observeSharedMessage: async () => ({ ...evidence, ...(changes[observations++] ?? {}) }),
    dispose: async () => { calls.push(["dispose"]); if (disposeFail) throw new Error("DISPOSAL_FAILED"); },
  };
  return { calls, acquire: async () => session };
}
const f = fixture();
const result = await executeChatPromptScreenshot(url, f.acquire, new Date("2026-11-27T01:00:00Z"));
assert.equal(result.metadata.height, 7200);
assert.equal(result.plan.theme, "dark");
assert.deepEqual(f.calls.map(x => x[0]), ["verify", "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled", "Emulation.setUserAgentOverride", "Emulation.setEmulatedMedia",
  "Page.navigate", "verify", "Page.captureScreenshot", "verify", "dispose"]);
const screenshot = f.calls.find(x => x[0] === "Page.captureScreenshot")[1];
assert.equal(screenshot.captureBeyondViewport, true);
assert.deepEqual(screenshot.clip, { ...bounds, scale: 1 });
for (const [options, error, noCapture] of [
  [{ changes: [{ candidateCount: 2 }] }, /TARGET_UNVERIFIED/, true],
  [{ changes: [{ url: "https://chatgpt.com/" }] }, /TARGET_UNVERIFIED/, true],
  [{ verifyFail: 1 }, /ADMISSION_LOST/, true],
  [{ verifyFail: 2 }, /ADMISSION_LOST/, true],
  [{ navigation: { errorText: "failed" } }, /NAVIGATION_FAILED/, true],
  [{ changes: [{}, { bounds: { ...bounds, height: 2401 } }] }, /TARGET_CHANGED/, false],
  [{ capture: { data: "!!!!" } }, /PAYLOAD_INVALID/, false],
  [{ verifyFail: 3 }, /ADMISSION_LOST/, false],
  [{ disposeFail: true }, /DISPOSAL_FAILED/, false],
]) {
  const bad = fixture(options);
  await assert.rejects(executeChatPromptScreenshot(url, bad.acquire), error);
  assert.equal(bad.calls.at(-1)[0], "dispose");
  if (noCapture) assert.equal(bad.calls.some(x => x[0] === "Page.captureScreenshot"), false);
}
let acquired = false;
await assert.rejects(executeChatPromptScreenshot("https://example.com/", async () => { acquired = true; }), /URL_INVALID/);
assert.equal(acquired, false);
console.log("chat prompt screenshot execution regression: PASS (mock CDP only)");
