import { readFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const options = parseArgs(process.argv.slice(2));
const connectorName = String(options.name ?? process.env.CONSOLE_MCP_CHATGPT_CONNECTOR_NAME ?? "console-mcp");
const connectorId = String(options.connectorId ?? process.env.CONSOLE_MCP_CHATGPT_CONNECTOR_ID ?? "asdk_app_6a387987d2f881918ffe72c70002307c");
const connectorUrl = String(options.url ?? process.env.CONSOLE_MCP_CHATGPT_CONNECTOR_URL ?? buildConnectorSettingsUrl(connectorId));
const timeoutMs = Math.max(5000, Number(options.timeoutSec ?? 45) * 1000);
const ports = String(options.ports ?? process.env.CONSOLE_MCP_BROWSER_DEVTOOLS_PORTS ?? "9222,9223")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0);

try {
  const result = await run(connectorName, ports, timeoutMs, connectorUrl);
  const expectedSchema = loadExpectedToolCatalog();
  const observedSchema = extractObservedToolCatalog(result.result);
  result.expected_schema = expectedSchema;
  result.observed_schema = observedSchema;
  result.schema_comparison = compareToolCatalogs(expectedSchema, observedSchema);
  result.refresh_click = extractRefreshClick(result.result);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 2;
} catch (error) {
  console.log(JSON.stringify({ ok: false, status: "SCRIPT_FAILED", connector_name: connectorName, error: sanitize(error) }, null, 2));
  process.exitCode = 2;
}

function buildConnectorSettingsUrl(id) {
  return `https://chatgpt.com/#settings/Connectors?connector=${encodeURIComponent(id)}`;
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

async function run(name, candidatePorts, timeout, targetUrl) {
  const attempts = [];
  for (const port of [...new Set(candidatePorts)]) {
    try {
      const target = await devtoolsJson(port, `/json/new?${encodeURIComponent(targetUrl)}`, "PUT", Math.min(timeout, 10000));
      if (!target.id) {
        attempts.push({ port, ok: false, status: "TARGET_ID_MISSING" });
        continue;
      }
      await devtoolsText(port, `/json/activate/${encodeURIComponent(target.id)}`, "GET", 3000).catch(() => undefined);
      const ready = await waitForTarget(port, target.id, Math.min(timeout, 15000));
      const websocket = ready?.webSocketDebuggerUrl ?? target.webSocketDebuggerUrl;
      if (!websocket) {
        attempts.push({ port, ok: false, status: "WEBSOCKET_MISSING", target_id: target.id });
        continue;
      }
      const result = await evaluate(websocket, refreshExpression(name, timeout), timeout + 5000);
      const item = {
        ok: Boolean(result?.ok),
        status: result?.ok ? "CONNECTOR_REFRESHED" : String(result?.status ?? "REFRESH_NOT_CONFIRMED"),
        connector_name: name,
        port,
        target_id: ready?.id ?? target.id,
        current_url: result?.href ?? ready?.url ?? null,
        result,
      };
      if (item.ok) return { ...item, attempts };
      attempts.push(item);
    } catch (error) {
      attempts.push({ port, ok: false, status: "ATTEMPT_FAILED", error: sanitize(error) });
    }
  }
  return { ok: false, status: "NEED_CHATGPT_DEVTOOLS_REFRESH", connector_name: name, target_url: targetUrl, ports: candidatePorts, attempts };
}

async function waitForTarget(port, targetId, timeout) {
  const until = Date.now() + timeout;
  let last = null;
  while (Date.now() <= until) {
    const targets = await devtoolsJson(port, "/json/list", "GET", 3000);
    last = Array.isArray(targets) ? targets.find((item) => item.id === targetId) ?? last : last;
    if (last?.url && last.url !== "about:blank" && last.webSocketDebuggerUrl) return last;
    await sleep(150);
  }
  return last;
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

function evaluate(websocketUrl, expression, timeout) {
  if (!globalThis.WebSocket) throw new Error("Node WebSocket client is unavailable.");
  return new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(websocketUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("DevTools evaluation timed out."));
    }, timeout);
    ws.onerror = (event) => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`DevTools WebSocket error: ${String(event)}`));
    };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result?.result?.value ?? null);
    };
  });
}

function refreshExpression(name, timeout) {
  return `
(async () => {
  const connectorName = ${JSON.stringify(name)};
  const deadline = Date.now() + ${JSON.stringify(timeout)};
  const events = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const isVisible = (node) => {
    if (!node || !(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const textOf = (node) => clean([node.getAttribute?.('aria-label'), node.getAttribute?.('title'), node.getAttribute?.('data-testid'), node.innerText, node.textContent].filter(Boolean).join(' '));
  const nodes = (root = document) => Array.from(root.querySelectorAll('button,a,[role="button"],[role="menuitem"],[role="tab"],[aria-label],[data-testid],div,span,p,h1,h2,h3')).filter(isVisible);
  const bodyText = () => clean(document.body?.innerText || document.documentElement?.innerText || '');
  const settingsOpen = () => /General|Notifications|Personalization|Connectors|Applications|Apps/i.test(bodyText()) && /Settings|General/i.test(bodyText());
  const findText = (patterns, root = document) => nodes(root).find((node) => patterns.some((pattern) => pattern.test(textOf(node))));
  const click = async (node, label) => {
    node.scrollIntoView?.({ block: 'center', inline: 'center' });
    const previousOutline = node.style?.outline;
    const previousOutlineOffset = node.style?.outlineOffset;
    if (node.style) {
      node.style.outline = '3px solid #22c55e';
      node.style.outlineOffset = '3px';
    }
    await sleep(350);
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    node.click?.();
    const clickedText = textOf(node).slice(0, 180);
    events.push({ action: 'click', label, text: clickedText, href: location.href, at: new Date().toISOString() });
    await sleep(500);
    if (node.style) {
      node.style.outline = previousOutline || '';
      node.style.outlineOffset = previousOutlineOffset || '';
    }
  };
  const waitFor = async (probe, label) => {
    while (Date.now() <= deadline) {
      const value = probe();
      if (value) return value;
      await sleep(250);
    }
    events.push({ action: 'timeout', label });
    return null;
  };

  await waitFor(() => document.readyState === 'interactive' || document.readyState === 'complete', 'document-ready');
  for (const hash of ['#settings/Connectors', '#settings/Applications', '#settings/Apps', '#settings/General']) {
    if (settingsOpen()) break;
    location.hash = hash;
    events.push({ action: 'hash', hash, href: location.href });
    await sleep(900);
  }
  if (!settingsOpen()) {
    const menu = findText([/profile/i, /account/i, /menu/i, /avatar/i]) || nodes().slice(-1)[0];
    if (menu) await click(menu, 'account-menu');
    const settings = await waitFor(() => findText([/^settings$/i, /settings/i]), 'settings-item');
    if (settings) await click(settings, 'settings');
  }
  if (!await waitFor(settingsOpen, 'settings-open')) return { ok: false, status: 'SETTINGS_NOT_OPENED', connectorName, href: location.href, title: document.title, events, bodySample: bodyText().slice(0, 800) };

  const tab = findText([/connectors?/i, /applications?/i, /^apps$/i]);
  if (tab) await click(tab, 'connectors-tab');
  await sleep(800);

  const escaped = connectorName.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const namePattern = new RegExp(escaped, 'i');
  const connector = await waitFor(() => findText([namePattern]), 'connector-name');
  if (!connector) return { ok: false, status: 'CONNECTOR_NOT_FOUND', connectorName, href: location.href, title: document.title, events, bodySample: bodyText().slice(0, 1000) };

  let container = connector;
  for (let i = 0; i < 8 && container?.parentElement; i += 1) {
    if (namePattern.test(textOf(container)) && /refresh|disconnect|permissions|oauth|allow/i.test(textOf(container))) break;
    container = container.parentElement;
  }
  const refresh = findText([/^refresh$/i, /refresh/i], container) || findText([/^refresh$/i, /refresh/i]);
  if (!refresh) return { ok: false, status: 'REFRESH_BUTTON_NOT_FOUND', connectorName, href: location.href, title: document.title, events, connectorText: textOf(container).slice(0, 1000) };
  await click(refresh, 'refresh');
  const confirmation = await waitFor(() => {
    const text = bodyText();
    return /actions refreshed|refreshed/i.test(text) ? (text.match(/.{0,60}(actions refreshed|refreshed).{0,80}/i)?.[0] || 'refreshed') : null;
  }, 'confirmation');
  const pageText = bodyText().slice(0, 20000);
  if (!confirmation) return { ok: false, status: 'REFRESH_CLICKED_CONFIRMATION_NOT_SEEN', connectorName, href: location.href, title: document.title, events, pageText };
  return { ok: true, status: 'ACTIONS_REFRESHED', connectorName, confirmation: clean(confirmation), href: location.href, title: document.title, events, pageText };
})()`;
}

function extractRefreshClick(refreshResult) {
  const events = Array.isArray(refreshResult?.events) ? refreshResult.events : [];
  const click = events.find((event) => event?.action === 'click' && event?.label === 'refresh') ?? null;
  return {
    clicked: Boolean(click),
    at: click?.at ?? null,
    text: click?.text ?? null,
  };
}

function loadExpectedToolCatalog() {
  const index = JSON.parse(readFileSync(join(rootDir, "policy", "console-tool-catalog-index.json"), "utf8"));
  const names = [];
  for (const fragmentPath of Array.isArray(index.fragments) ? index.fragments : []) {
    const fragment = JSON.parse(readFileSync(join(rootDir, fragmentPath), "utf8"));
    for (const item of Array.isArray(fragment.tools) ? fragment.tools : []) {
      if (typeof item.canonicalName === "string") names.push(item.canonicalName);
    }
  }
  const tools = [...new Set(names)].sort();
  return { source: "policy/console-tool-catalog-index.json", count: tools.length, tools };
}

function extractObservedToolCatalog(refreshResult) {
  const text = [
    refreshResult?.bodySample,
    refreshResult?.connectorText,
    refreshResult?.pageText,
    refreshResult?.confirmation,
  ].filter(Boolean).join(" ");
  const tokens = text.replaceAll("\n", " ").replaceAll("\t", " ").split(" ");
  const tools = [...new Set(tokens.filter((token) => token.startsWith("console.read_.") || token.startsWith("console.write.")))].sort();
  return { exposed: tools.length > 0, count: tools.length, tools };
}

function compareToolCatalogs(expected, observed) {
  if (!observed.exposed) {
    return {
      ok: null,
      status: "OBSERVED_TOOLS_NOT_EXPOSED_BY_CHATGPT_UI",
      expected_count: expected.count,
      observed_count: 0,
      missing_count: null,
      unexpected_count: null,
    };
  }
  const missing = expected.tools.filter((name) => !observed.tools.includes(name));
  const unexpected = observed.tools.filter((name) => !expected.tools.includes(name));
  return {
    ok: missing.length === 0 && unexpected.length === 0,
    status: missing.length === 0 && unexpected.length === 0 ? "OBSERVED_TOOLS_MATCH_EXPECTED" : "OBSERVED_TOOLS_DIFFER_FROM_EXPECTED",
    expected_count: expected.count,
    observed_count: observed.count,
    missing_count: missing.length,
    unexpected_count: unexpected.length,
    missing,
    unexpected,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(value) {
  return String(value?.stack ?? value?.message ?? value)
    .replace(/(Authorization:\s*Bearer\s+)[^\s"]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, "[redacted-jwt]");
}
