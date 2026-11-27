import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { VisibleSessionEvidence } from "../service/visible-browser-session.js";
import type { SharedMessageEvidence } from "./chat-prompt-screenshot.js";

type Rpc = {
  call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  close(): void;
};

// One persistent connection is necessary for session-scoped emulation.
function connectBrowser(anchor: VisibleSessionEvidence): Rpc {
  if (anchor.endpoint !== "http://127.0.0.1:9223" || !anchor.browserInstance ||
      !/^\/devtools\/browser\/[a-f0-9-]+$/i.test(anchor.browserInstance))
    throw new Error("CHAT_PROMPT_SCREENSHOT_BROWSER_IDENTITY_INVALID");
  const socket = new WebSocket("ws://127.0.0.1:9223" + anchor.browserInstance);
  let id = 0;
  let closed = false;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let rejectOpen: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    rejectOpen = reject;
    const timer = setTimeout(() => reject(new Error("CHAT_PROMPT_SCREENSHOT_CDP_CONNECT_TIMEOUT")), 3000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CHAT_PROMPT_SCREENSHOT_CDP_CONNECT_FAILED")); }, { once: true });
    socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("CHAT_PROMPT_SCREENSHOT_CDP_CLOSED")); }, { once: true });
  });
  // Construction can fail before the first command awaits the connection.
  void ready.catch(() => {});
  const stop = () => {
    closed = true;
    const error = new Error("CHAT_PROMPT_SCREENSHOT_CDP_CLOSED");
    rejectOpen(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  socket.addEventListener("close", stop);
  socket.addEventListener("error", stop);
  socket.addEventListener("message", event => {
    try {
      const raw = String(event.data);
      if (raw.length > 13 * 1024 * 1024) { socket.close(); stop(); return; }
      const message = JSON.parse(raw);
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error("CHAT_PROMPT_SCREENSHOT_CDP_COMMAND_FAILED"));
      else item.resolve(message.result);
    } catch { socket.close(); stop(); }
  });
  return {
    async call(method, params = {}, sessionId) {
      await ready;
      if (closed) throw new Error("CHAT_PROMPT_SCREENSHOT_CDP_CLOSED");
      const current = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(current); reject(new Error("CHAT_PROMPT_SCREENSHOT_CDP_TIMEOUT")); }, 10000);
        pending.set(current, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id: current, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch { clearTimeout(timer); pending.delete(current); reject(new Error("CHAT_PROMPT_SCREENSHOT_CDP_SEND_FAILED")); }
      });
    },
    close() { stop(); socket.close(); },
  };
}

// Candidate selector: must be confirmed by live shared-page acceptance.
// No last-answer fallback, no arbitrary selectors, no account/profile access.
const OBSERVE = `(() => {
  const nodes = [...document.querySelectorAll('main [data-message-author-role]')];
  const node = nodes.length === 1 ? nodes[0] : null;
  const role = node?.getAttribute('data-message-author-role');
  const rect = node?.getBoundingClientRect();
  const text = node?.innerText || '';
  const ready = document.readyState === 'complete' && (!document.fonts || document.fonts.status === 'loaded')
    && !!node && ['user','assistant'].includes(role) && text.trim().length > 0
    && [...node.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0)
    && !document.querySelector('input[type=password]');
  return { url: location.href, ready, candidateCount: nodes.length, role,
    content: node?.outerHTML || '', bounds: rect ? { x: rect.x + scrollX, y: rect.y + scrollY,
    width: rect.width, height: rect.height } : null };
})()`;

export async function acquireChatPromptScreenshotTarget(
  anchor: VisibleSessionEvidence,
  verifyAnchor: () => Promise<void>,
  connect: (anchor: VisibleSessionEvidence) => Rpc = connectBrowser,
) {
  await verifyAnchor();
  const rpc = connect(anchor);
  let contextId: string | undefined;
  let targetId: string | undefined;
  let sessionId: string | undefined;
  let fingerprint: string | undefined;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      if (contextId) {
        await verifyAnchor();
        await rpc.call("Target.disposeBrowserContext", { browserContextId: contextId });
        const remaining = await rpc.call("Target.getBrowserContexts");
        if (!Array.isArray(remaining?.browserContextIds) || remaining.browserContextIds.includes(contextId))
          throw new Error("CHAT_PROMPT_SCREENSHOT_DISPOSAL_UNVERIFIED");
        await verifyAnchor();
      }
    } finally { rpc.close(); }
  };
  const verify = async () => {
    if (disposed || !contextId || !targetId || !sessionId) throw new Error("CHAT_PROMPT_SCREENSHOT_TARGET_UNBOUND");
    await verifyAnchor();
    const result = await rpc.call("Target.getTargetInfo", { targetId });
    const info = result?.targetInfo;
    if (info?.targetId !== targetId || info?.browserContextId !== contextId || info?.type !== "page")
      throw new Error("CHAT_PROMPT_SCREENSHOT_TARGET_CHANGED");
  };
  try {
    // An anonymous context prevents capture from accessing existing private tabs.
    // disposeOnDetach is a cleanup fallback if the transport disappears.
    const context = await rpc.call("Target.createBrowserContext", { disposeOnDetach: true });
    if (typeof context?.browserContextId !== "string" || !context.browserContextId)
      throw new Error("CHAT_PROMPT_SCREENSHOT_CONTEXT_UNAVAILABLE");
    contextId = context.browserContextId;
    const target = await rpc.call("Target.createTarget", { url: "about:blank", browserContextId: contextId, background: true });
    if (typeof target?.targetId !== "string" || !/^[a-f0-9]{32}$/i.test(target.targetId))
      throw new Error("CHAT_PROMPT_SCREENSHOT_TARGET_UNAVAILABLE");
    targetId = target.targetId;
    const attached = await rpc.call("Target.attachToTarget", { targetId, flatten: true });
    if (typeof attached?.sessionId !== "string" || !attached.sessionId)
      throw new Error("CHAT_PROMPT_SCREENSHOT_SESSION_UNAVAILABLE");
    sessionId = attached.sessionId;
    await verify();
    return {
      verify,
      async call(method: string, params: Record<string, unknown>) {
        if (disposed || !sessionId) throw new Error("CHAT_PROMPT_SCREENSHOT_TARGET_UNBOUND");
        // This internal session is used only by the fixed screenshot executor.
        return rpc.call(method, params, sessionId);
      },
      async observeSharedMessage(expectedUrl: string): Promise<SharedMessageEvidence> {
        let previous: string | undefined;
        for (let i = 0; i < 20; i++) {
          const result = await rpc.call("Runtime.evaluate", { expression: OBSERVE, returnByValue: true }, sessionId);
          const value = result?.result?.value;
          if (value?.url && value.url !== expectedUrl && value.url !== "about:blank")
            throw new Error("CHAT_PROMPT_SCREENSHOT_TARGET_UNVERIFIED");
          if (value?.url === expectedUrl && value.ready === true && value.candidateCount === 1 &&
              typeof value.content === "string" && value.content.length > 0 && value.content.length <= 2 * 1024 * 1024 && value.bounds) {
            const current = createHash("sha256").update(value.content).update(JSON.stringify(value.bounds)).digest("hex");
            if (previous === current) {
              if (fingerprint && fingerprint !== current) throw new Error("CHAT_PROMPT_SCREENSHOT_TARGET_CHANGED");
              fingerprint = current;
              return { url: value.url, ready: true, candidateCount: 1, exactSharedMessage: true, bounds: value.bounds };
            }
            previous = current;
          } else previous = undefined;
          await delay(250);
        }
        throw new Error("CHAT_PROMPT_SCREENSHOT_TARGET_UNVERIFIED");
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
