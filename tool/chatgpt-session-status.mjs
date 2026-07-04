import { request } from "node:http";

const options = parseArgs(process.argv.slice(2));
const ports = String(options.ports ?? process.env.CONSOLE_MCP_BROWSER_DEVTOOLS_PORTS ?? "9222,9223")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0);
const timeoutMs = Math.min(10000, Math.max(1000, Number(options.timeoutMs ?? 5000)));

try {
  const result = await run(ports, timeoutMs);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 2;
} catch (error) {
  console.log(JSON.stringify({ ok: false, status: "SCRIPT_FAILED", error: sanitize(error) }, null, 2));
  process.exitCode = 2;
}

function parseArgs(items) {
  const result = {};
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item.startsWith("--")) continue;
    const eq = item.indexOf("=");
    if (eq > 0) {
      result[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const next = items[i + 1];
    result[item.slice(2)] = next && !next.startsWith("--") ? next : true;
    if (next && !next.startsWith("--")) i += 1;
  }
  return result;
}

async function run(candidatePorts, timeout) {
  const attempts = [];
  for (const port of [...new Set(candidatePorts)]) {
    try {
      const target = await resolveChatgptTarget(port);
      if (!target) {
        attempts.push({ port, ok: false, status: "CHATGPT_PAGE_MISSING" });
        continue;
      }
      const websocket = target.webSocketDebuggerUrl;
      if (!websocket) {
        attempts.push({ port, ok: false, status: "WEBSOCKET_MISSING", target_id: target.id, url: target.url });
        continue;
      }
      const cdpReady = await waitForRuntimeContext(websocket, timeout);
      if (!cdpReady.ok) {
        attempts.push({ port, ok: false, status: cdpReady.status, target_id: target.id, url: target.url, cdp_ready: cdpReady });
        continue;
      }
      const dom = await evaluateWithRuntimeRetry(websocket, classificationExpression(), timeout);
      const status = classify(dom);
      const item = {
        ok: status === "CHATGPT_AUTHENTICATED",
        status,
        port,
        target_id: target.id,
        url: dom?.url ?? target.url,
        title: dom?.title ?? target.title ?? null,
        ready_for_prompt: status === "CHATGPT_AUTHENTICATED",
        dom,
      };
      return { ...item, attempts };
    } catch (error) {
      attempts.push({ port, ok: false, status: "ATTEMPT_FAILED", error: sanitize(error) });
    }
  }
  const last = attempts.at(-1);
  return last ? { ...last, attempts } : { ok: false, status: "NO_DEVTOOLS_PORTS", attempts };
}

async function resolveChatgptTarget(port) {
  const targets = await devtoolsJson(port, "/json/list", "GET", 3000);
  if (!Array.isArray(targets)) return null;
  const pages = targets
    .filter((target) => target?.type === "page")
    .filter((target) => typeof target.url === "string" && target.url.startsWith("https://chatgpt.com"))
    .filter((target) => typeof target.webSocketDebuggerUrl === "string" && target.webSocketDebuggerUrl.length > 0);
  return pages.find((target) => target.url === "https://chatgpt.com/" || target.url === "https://chatgpt.com")
    ?? pages.find((target) => !target.url.includes("#settings"))
    ?? pages[0]
    ?? null;
}

function classify(dom) {
  if (!dom) return "CHATGPT_UNKNOWN";
  if (dom.blocked) return "CHATGPT_BLOCKED_OR_RATE_LIMITED";
  if (dom.login && !dom.composer) return "CHATGPT_GUEST_LOGIN";
  if (dom.composer && !dom.login) return "CHATGPT_AUTHENTICATED";
  if (dom.composer) return "CHATGPT_AUTHENTICATED_WEAK";
  if (dom.loading) return "CHATGPT_PAGE_LOADING";
  return "CHATGPT_UNKNOWN";
}

function classificationExpression() {
  return `(() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const text = clean(document.body?.innerText || document.documentElement?.innerText || '');
    const lower = text.toLowerCase();
    const visible = (node) => {
      if (!node || !(node instanceof Element)) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const composer = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],div.ProseMirror,[data-testid="composer"],[aria-label*="Message"],[placeholder*="Message"]')).some(visible);
    const login = /\\b(log in|login|sign up|sign in)\\b|войти|зарегистрироваться/i.test(text);
    const blocked = /too many requests|rate limit|captcha|cloudflare|unavailable|something went wrong|blocked|недоступн|слишком много запросов/i.test(text);
    const loading = document.readyState !== 'complete' || lower.includes('loading') || lower.includes('загрузка');
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      textLength: text.length,
      composer,
      login,
      blocked,
      loading,
      sample: text.slice(0, 700),
    };
  })()`;
}

function devtoolsJson(port, path, method, timeout) {
  return devtoolsText(port, path, method, timeout).then((text) => JSON.parse(text));
}

function devtoolsText(port, path, method, timeout) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, timeout }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`DevTools HTTP ${res.statusCode}: ${body}`));
        else resolve(body);
      });
    });
    req.on("timeout", () => req.destroy(new Error(`DevTools request timed out on ${port}`)));
    req.on("error", reject);
    req.end();
  });
}

async function waitForRuntimeContext(websocketUrl, timeout) {
  try {
    await evaluate(websocketUrl, "Boolean(globalThis && document)", timeout);
    return { ok: true, status: "CDP_RUNTIME_CONTEXT_READY" };
  } catch (error) {
    return { ok: false, status: "CDP_RUNTIME_CONTEXT_FAILED", error: sanitize(error) };
  }
}

async function evaluateWithRuntimeRetry(websocketUrl, expression, timeout) {
  return evaluate(websocketUrl, expression, timeout);
}

function evaluate(websocketUrl, expression, timeout) {
  if (!globalThis.WebSocket) throw new Error("Node WebSocket client is unavailable.");
  return new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(websocketUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("DevTools evaluation timed out."));
    }, timeout);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    });

    ws.addEventListener("message", (event) => {
      try {
        const data = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
        const payload = JSON.parse(data);
        if (payload.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        if (payload.error) {
          reject(new Error(payload.error.message || JSON.stringify(payload.error)));
          return;
        }
        const result = payload.result?.result;
        if (result?.subtype === "error") {
          reject(new Error(result.description || result.value || "Runtime evaluation returned an error."));
          return;
        }
        resolve(result?.value ?? null);
      } catch (error) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(error);
      }
    });

    ws.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(event?.message || "DevTools WebSocket error."));
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
    });
  });
}

function sanitize(error) {
  if (!error) return null;
  if (error instanceof Error) return String(error.message || error).slice(0, 2000);
  return String(error).slice(0, 2000);
}
