import assert from "node:assert/strict";
import { acquireChatPromptScreenshotTarget } from "../src/engine/chat-prompt-screenshot-target.ts";

const url = "https://chatgpt.com/s/t_0123456789abcdef0123456789abcdef";
const anchor = { endpoint: "http://127.0.0.1:9223", browserInstance: "/devtools/browser/abc-123" };
const targetId = "A".repeat(32);
const contextId = "owned-context";
const bounds = { x: 10, y: 20, width: 370, height: 2400 };
const value = { url, ready: true, candidateCount: 1, role: "assistant", content: "<div>Shared answer</div>", bounds };
function fixture({ observations = [value], targetMismatch = false, disposeMismatch = false, deny = false, now = () => performance.now(), verify = async () => {} } = {}) {
  const calls = [];
  let index = 0;
  const rpc = {
    async call(method, params, sessionId) {
      calls.push([method, params, sessionId]);
      switch (method) {
        case "Target.createBrowserContext": return { browserContextId: contextId };
        case "Target.createTarget": return { targetId };
        case "Target.attachToTarget": return { sessionId: "owned-session" };
        case "Target.getTargetInfo": return { targetInfo: { type: "page", targetId, browserContextId: targetMismatch ? "other" : contextId } };
        case "Runtime.evaluate": return { result: { value: observations[Math.min(index++, observations.length - 1)] } };
        case "Target.disposeBrowserContext": return {};
        case "Target.getBrowserContexts": return { browserContextIds: disposeMismatch ? [contextId] : [] };
        default: return {};
      }
    },
    close() { calls.push(["close"]); },
  };
  return { calls, acquire: () => acquireChatPromptScreenshotTarget(anchor, async () => {
    if (deny) throw new Error("ADMISSION_DENIED");
    await verify();
  }, () => { calls.push(["connect"]); return rpc; }, now) };
}
const f = fixture();
const session = await f.acquire();
assert.deepEqual(await session.observeSharedMessage(url), { url, ready: true, candidateCount: 1, exactSharedMessage: true, bounds });
await session.call("Emulation.setDeviceMetricsOverride", { width: 393 });
await session.dispose();
assert.deepEqual(f.calls.find(c => c[0] === "Target.createBrowserContext")[1], { disposeOnDetach: true });
assert.deepEqual(f.calls.find(c => c[0] === "Target.createTarget")[1], { url: "about:blank", browserContextId: contextId, background: true });
assert.equal(f.calls.find(c => c[0] === "Emulation.setDeviceMetricsOverride")[2], "owned-session");
assert.deepEqual(f.calls.find(c => c[0] === "Target.disposeBrowserContext")[1], { browserContextId: contextId });
assert.equal(f.calls.at(-1)[0], "close");
const denied = fixture({ deny: true });
await assert.rejects(denied.acquire(), /ADMISSION_DENIED/);
assert.equal(denied.calls.length, 0);
const mismatched = fixture({ targetMismatch: true });
await assert.rejects(mismatched.acquire(), /TARGET_CHANGED/);
assert.ok(mismatched.calls.some(c => c[0] === "Target.disposeBrowserContext"));
const redirect = fixture({ observations: [{ ...value, url: "https://chatgpt.com/" }] });
const redirected = await redirect.acquire();
try { await assert.rejects(redirected.observeSharedMessage(url), /TARGET_UNVERIFIED/); } finally { await redirected.dispose(); }
const changed = fixture({ observations: [value, value, { ...value, content: "<div>Changed</div>" }] });
const unstable = await changed.acquire();
try {
  await unstable.observeSharedMessage(url);
  await assert.rejects(unstable.observeSharedMessage(url), /TARGET_CHANGED/);
} finally { await unstable.dispose(); }
const leaked = fixture({ disposeMismatch: true });
const leaking = await leaked.acquire();
await assert.rejects(leaking.dispose(), /DISPOSAL_UNVERIFIED/);
assert.equal(leaked.calls.at(-1)[0], "close");
let clock = 0;
const timed = fixture({ now: () => clock });
const expiring = await timed.acquire();
clock = 45_001;
await assert.rejects(expiring.call("Page.captureScreenshot", {}), /DEADLINE_EXCEEDED/);
assert.ok(!timed.calls.some(c => c[0] === "Page.captureScreenshot"));
await expiring.dispose();
assert.ok(timed.calls.some(c => c[0] === "Target.disposeBrowserContext"));
assert.equal(timed.calls.at(-1)[0], "close");
clock = 0;
const overdue = fixture({ now: () => clock });
const overdueSession = await overdue.acquire();
clock = 60_001;
await assert.rejects(overdueSession.dispose(), /DEADLINE_EXCEEDED/);
assert.equal(overdue.calls.at(-1)[0], "close");
let admitted = true;
const lost = fixture({ verify: async () => {
  if (!admitted) throw new Error("ADMISSION_LOST");
} });
const lostSession = await lost.acquire();
admitted = false;
await assert.rejects(lostSession.verify(), /ADMISSION_LOST/);
await assert.rejects(lostSession.dispose(), /ADMISSION_LOST/);
assert.ok(lost.calls.some(c => c[0] === "Target.disposeBrowserContext"));
assert.ok(lost.calls.some(c => c[0] === "Target.getBrowserContexts"));
assert.equal(lost.calls.at(-1)[0], "close");
console.log("chat prompt screenshot target regression: PASS (mock CDP, shared deadline and cleanup reserve)");
