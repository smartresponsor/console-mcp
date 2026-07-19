import { readFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const options = parseArgs(process.argv.slice(2));
const connectorName = String(options.name ?? process.env.CONSOLE_MCP_CHATGPT_CONNECTOR_NAME ?? "console-mcp");
const connectorId = String(options.connectorId ?? process.env.CONSOLE_MCP_CHATGPT_CONNECTOR_ID ?? "asdk_app_6a387987d2f881918ffe72c70002307c");
const connectorUrl = String(options.url ?? process.env.CONSOLE_MCP_CHATGPT_CONNECTOR_URL ?? buildConnectorSettingsUrl(connectorId));
const timeoutSec = Number(options.timeoutSec ?? options["timeout-sec"] ?? process.env.CONSOLE_MCP_CHATGPT_CONNECTOR_REFRESH_TIMEOUT_SEC ?? 8);
const timeoutMs = Math.min(120000, Math.max(5000, timeoutSec * 1000));
const ports = String(options.ports ?? process.env.CONSOLE_MCP_BROWSER_DEVTOOLS_PORTS ?? "9222,9223")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0);

let cleanupBefore = null;
let cleanupAfter = null;

try {
  cleanupBefore = await cleanupBrowserTargetsAcrossPorts(ports, timeoutMs, "before-refresh");
  const expectedSchema = loadExpectedToolCatalog();
  const result = await run(connectorName, connectorId, ports, timeoutMs, connectorUrl, expectedSchema);
  cleanupAfter = await cleanupBrowserTargetsAcrossPorts(ports, timeoutMs, "after-refresh");
  result.browser_cleanup_before = cleanupBefore;
  result.browser_cleanup_after = cleanupAfter;
  const observedSchema = extractObservedToolCatalog(result.result);
  result.expected_schema = expectedSchema;
  result.observed_schema = observedSchema;
  result.schema_comparison = compareToolCatalogs(expectedSchema, observedSchema);
  result.refresh_click = extractRefreshClick(result.result);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 2;
} catch (error) {
  if (!cleanupAfter) {
    cleanupAfter = await cleanupBrowserTargetsAcrossPorts(ports, timeoutMs, "after-refresh").catch((cleanupError) => ({
      ok: false,
      status: "BROWSER_LIFECYCLE_CLEANUP_FAILED",
      phase: "after-refresh",
      error: sanitize(cleanupError),
    }));
  }
  console.log(JSON.stringify({
    ok: false,
    status: "SCRIPT_FAILED",
    connector_name: connectorName,
    browser_cleanup_before: cleanupBefore,
    browser_cleanup_after: cleanupAfter,
    error: sanitize(error),
  }, null, 2));
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

async function run(name, id, candidatePorts, timeout, targetUrl, expectedSchema) {
  const attempts = [];
  for (const port of [...new Set(candidatePorts)]) {
    try {
      const target = await resolveRefreshTarget(port, targetUrl, Math.min(timeout, 10000));
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
      const cdpReady = await waitForRuntimeContext(websocket, Math.min(timeout, 15000));
      if (!cdpReady.ok) {
        attempts.push({ port, ok: false, status: cdpReady.status, target_id: ready?.id ?? target.id, cdp_ready: cdpReady });
        continue;
      }
      const result = await refreshConnectorInTarget(port, ready?.id ?? target.id, websocket, name, id, timeout, expectedSchema);
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
  const lastAttempt = attempts.at(-1);
  if (lastAttempt) return { ...lastAttempt, attempts };
  return { ok: false, status: "NEED_CHATGPT_DEVTOOLS_REFRESH", connector_name: name, target_url: targetUrl, ports: candidatePorts, attempts };
}

async function refreshConnectorInTarget(port, targetId, websocket, name, id, timeout, expectedSchema) {
  const lightweightTimeout = Math.min(timeout, 30000);
  let result = await evaluateWithRuntimeRetry(websocket, lightweightRefreshExpression(name, id, expectedSchema), lightweightTimeout);
  if (result?.status === "CONNECTOR_SETTINGS_NAVIGATION_REQUESTED") {
    result = await retryRefreshAfterNavigation(port, targetId, websocket, lightweightRefreshExpression(name, id, expectedSchema), timeout);
  }
  if (shouldRunFullRefreshFallback(result)) {
    const fullTimeout = Math.min(timeout, 90000);
    result = await retryRefreshAfterNavigation(port, targetId, websocket, refreshExpression(name, id, fullTimeout), fullTimeout);
  }
  return result;
}

async function retryRefreshAfterNavigation(port, targetId, fallbackWebsocket, expression, timeout) {
  const deadline = Date.now() + Math.min(timeout, 90000);
  let currentTargetId = targetId;
  let currentWebsocket = fallbackWebsocket;
  let lastError = null;

  for (let attempt = 1; attempt <= 4 && Date.now() < deadline; attempt += 1) {
    const current = await waitForTarget(port, currentTargetId, Math.min(deadline - Date.now(), 15000));
    if (current?.id) currentTargetId = current.id;
    if (current?.webSocketDebuggerUrl) currentWebsocket = current.webSocketDebuggerUrl;

    if (!current?.webSocketDebuggerUrl && attempt > 1) {
      const replacement = await resolveRefreshTarget(port, connectorUrl, Math.min(deadline - Date.now(), 10000));
      if (replacement?.id) currentTargetId = replacement.id;
      if (replacement?.webSocketDebuggerUrl) currentWebsocket = replacement.webSocketDebuggerUrl;
    }

    const runtime = await waitForRuntimeContext(currentWebsocket, Math.min(deadline - Date.now(), 15000));
    if (!runtime.ok) {
      lastError = new Error(String(runtime.error ?? runtime.status));
      await sleep(500);
      continue;
    }

    await sleep(1000);
    try {
      const result = await evaluateWithRuntimeRetry(currentWebsocket, expression, Math.min(deadline - Date.now(), 30000));
      if (result?.status !== "CONNECTOR_SETTINGS_NAVIGATION_REQUESTED") return result;
    } catch (error) {
      lastError = error;
      if (!isTransientTargetNavigationError(error)) throw error;
    }

    const replacement = await resolveRefreshTarget(port, connectorUrl, Math.min(deadline - Date.now(), 10000));
    if (replacement?.id) currentTargetId = replacement.id;
    if (replacement?.webSocketDebuggerUrl) currentWebsocket = replacement.webSocketDebuggerUrl;
    await sleep(500);
  }

  throw lastError ?? new Error("Connector refresh target did not stabilize after navigation.");
}

function shouldRunFullRefreshFallback(result) {
  return result?.status === "REFRESH_BUTTON_NOT_FOUND_LIGHTWEIGHT"
    || result?.status === "CONNECTOR_SETTINGS_NAVIGATION_REQUESTED"
    || result?.status === "CONNECTOR_SETTINGS_HASH_NOT_RENDERED"
    || result?.connectorSeen === false;
}

async function resolveRefreshTarget(port, targetUrl, timeout) {
  const existing = await findExistingTarget(port, targetUrl).catch(() => null);
  if (existing) return { ...existing, reused: true };
  const created = await devtoolsJson(port, `/json/new?${encodeURIComponent(targetUrl)}`, "PUT", timeout);
  return { ...created, reused: false };
}

async function findExistingTarget(port, targetUrl) {
  const targets = await devtoolsJson(port, "/json/list", "GET", 3000);
  if (!Array.isArray(targets)) return null;
  const normalizedTargetUrl = normalizeChatgptUrl(targetUrl);
  const candidates = targets
    .filter((target) => target?.type === "page")
    .filter((target) => typeof target.url === "string" && target.url.startsWith("https://chatgpt.com/"))
    .filter((target) => typeof target.webSocketDebuggerUrl === "string" && target.webSocketDebuggerUrl.length > 0);
  return candidates.find((target) => normalizeChatgptUrl(target.url) === normalizedTargetUrl)
    ?? candidates.find((target) => target.url.includes("#settings/Connectors") && target.url.includes("connector="))
    ?? null;
}

function normalizeChatgptUrl(value) {
  try {
    const url = new URL(value);
    url.search = "";
    return url.toString();
  } catch {
    return String(value || "");
  }
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

function isTransientTargetNavigationError(error) {
  return /Inspected target navigated or closed|Target closed|WebSocket is not open|Cannot find default execution context|execution context was destroyed|Cannot find context with specified id/i.test(String(error?.stack ?? error?.message ?? error));
}

function isMissingExecutionContextError(error) {
  return /Cannot find default execution context|execution context was destroyed|Cannot find context with specified id/i.test(String(error?.stack ?? error?.message ?? error));
}

async function waitForRuntimeContext(websocketUrl, timeout) {
  const until = Date.now() + timeout;
  let attempts = 0;
  let lastError = null;
  while (Date.now() <= until) {
    attempts += 1;
    try {
      await evaluate(websocketUrl, "Boolean(globalThis && document)", 3000);
      return { ok: true, status: "CDP_RUNTIME_CONTEXT_READY", attempts };
    } catch (error) {
      lastError = sanitize(error);
      if (!isMissingExecutionContextError(error)) return { ok: false, status: "CDP_RUNTIME_CONTEXT_FAILED", attempts, error: lastError };
      await sleep(250);
    }
  }
  return { ok: false, status: "CDP_RUNTIME_CONTEXT_TIMEOUT", attempts, error: lastError };
}

async function evaluateWithRuntimeRetry(websocketUrl, expression, timeout) {
  const until = Date.now() + timeout;
  let lastError = null;
  while (Date.now() <= until) {
    try {
      return await evaluate(websocketUrl, expression, Math.max(1000, until - Date.now()));
    } catch (error) {
      lastError = error;
      if (!isMissingExecutionContextError(error)) throw error;
      await sleep(250);
    }
  }
  throw lastError ?? new Error("DevTools evaluation timed out while waiting for Runtime execution context.");
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

function lightweightRefreshExpression(name, id, expectedSchema) {
  return `
(async () => {
  const connectorName = ${JSON.stringify(name)};
  const connectorId = ${JSON.stringify(id)};
  const targetUrl = ${JSON.stringify(connectorUrl)};
  const expectedTools = ${JSON.stringify(expectedSchema.tools)};
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 500)));
  const visible = (node) => {
    if (!node || !(node instanceof Element)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const labelOf = (node) => clean([node.getAttribute?.('aria-label'), node.getAttribute?.('title'), node.getAttribute?.('data-testid'), node.textContent].filter(Boolean).join(' ')).slice(0, 500);
  const readPageText = () => clean(Array.from(document.querySelectorAll('h1,h2,h3,p,button,a,[role="button"],[role="menuitem"],[role="tab"],[aria-label],[data-testid],label')).filter(visible).slice(0, 800).map(labelOf).join(' ')).slice(0, 120000);
  const href = location.href;
  const title = document.title;
  const events = [];
  const initialPageText = readPageText();
  const expectedToolSet = new Set(expectedTools);
  if (!href.includes(connectorId)) {
    location.href = targetUrl;
    events.push({ action: 'navigate', targetUrl, href: location.href, at: new Date().toISOString() });
    return { ok: false, status: 'CONNECTOR_SETTINGS_NAVIGATION_REQUESTED', connectorName, connectorId, href: location.href, title, events, diagnostics: { visibleNodeCount: document.querySelectorAll('h1,h2,h3,p,button,a,[role="button"],[role="menuitem"],[role="tab"],[aria-label],[data-testid],label').length } };
  }
  const actionNodes = Array.from(document.querySelectorAll('button,a,[role="button"],[role="menuitem"]')).filter(visible);
  const actions = actionNodes.map((node) => ({ node, text: labelOf(node), disabled: Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true' }));
  const refreshItem = actions.find((item) => /(^|\\b)refresh(\\b|$)/i.test(item.text) && !item.disabled);
  const connectorSeen = new RegExp(connectorName.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&'), 'i').test(initialPageText) || /Console MCP/i.test(initialPageText);
  const connectorIdSeen = initialPageText.includes(connectorId) || href.includes(connectorId);
  const observedInitialTools = [...new Set([...initialPageText.matchAll(/\\bconsole\\.(?:read_|write)\\.[A-Za-z0-9_.]+/g)].map((match) => match[0]))].sort();
  const schemaAlreadyCurrent = observedInitialTools.length === expectedTools.length
    && observedInitialTools.every((tool) => expectedToolSet.has(tool));
  if (schemaAlreadyCurrent) {
    events.push({ action: 'skip-refresh', reason: 'schema-current', observedToolCount: observedInitialTools.length, expectedToolCount: expectedTools.length, href, at: new Date().toISOString() });
    return { ok: true, status: 'CONNECTOR_REFRESH_SKIPPED_SCHEMA_CURRENT_LIGHTWEIGHT', connectorName, connectorId, href, title, connectorSeen, connectorIdSeen, observedToolCount: observedInitialTools.length, observedTools: observedInitialTools, events };
  }
  if (!refreshItem) {
    const homeComposerSeen = /What’s on your mind today\?|What's on your mind today\?|Send prompt|New chat/i.test(initialPageText);
    const status = homeComposerSeen && connectorIdSeen ? 'CONNECTOR_SETTINGS_HASH_NOT_RENDERED' : 'REFRESH_BUTTON_NOT_FOUND_LIGHTWEIGHT';
    return { ok: false, status, connectorName, connectorId, href, title, connectorSeen, connectorIdSeen, homeComposerSeen, actionCount: actions.length, actionSummary: actions.slice(0, 80).map((item) => ({ refreshLike: /(^|\b)refresh(\b|$)/i.test(item.text), disabled: item.disabled })) };
  }
  refreshItem.node.scrollIntoView?.({ block: 'center', inline: 'center' });
  refreshItem.node.focus?.({ preventScroll: true });
  refreshItem.node.click();
  events.push({ action: 'click', label: 'refresh', text: refreshItem.text, href, at: new Date().toISOString() });
  let pageText = initialPageText;
  let observedToolCount = 0;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await sleep(500);
    pageText = readPageText();
    observedToolCount = [...new Set([...pageText.matchAll(/\\bconsole\\.(?:read_|write)\\.[A-Za-z0-9_.]+/g)].map((match) => match[0]))].length;
    const refreshed = /actions refreshed|refreshed|refresh complete|updated/i.test(pageText);
    events.push({ action: 'observe-after-refresh', attempt, observedToolCount, refreshed, href: location.href, at: new Date().toISOString() });
    if (observedToolCount > 0 || refreshed) break;
  }
  const observedTools = [...new Set([...pageText.matchAll(/\bconsole\.(?:read_|write)\.[A-Za-z0-9_.]+/g)].map((match) => match[0]))].sort();
  return { ok: true, status: observedToolCount > 0 ? 'REFRESH_CLICKED_SCHEMA_VISIBLE_LIGHTWEIGHT' : 'REFRESH_CLICKED_LIGHTWEIGHT', connectorName, connectorId, href: location.href, title: document.title, connectorSeen, connectorIdSeen, observedToolCount, observedTools, events };
})()`;
}

function refreshExpression(name, id, timeout) {
  return `
(async () => {
  const connectorName = ${JSON.stringify(name)};
  const connectorId = ${JSON.stringify(id)};
  const targetUrl = ${JSON.stringify(connectorUrl)};
  const deadline = Date.now() + ${JSON.stringify(timeout)};
  const events = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 50)));
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const isVisible = (node) => {
    if (!node || !(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const textOf = (node) => clean([node.getAttribute?.('aria-label'), node.getAttribute?.('title'), node.getAttribute?.('data-testid'), node.textContent].filter(Boolean).join(' ')).slice(0, 1200);
  const nodes = (root = document) => Array.from(root.querySelectorAll('button,a,[role="button"],[role="menuitem"],[role="tab"],[aria-label],[data-testid],div,span,p,h1,h2,h3')).slice(0, 2500).filter(isVisible);
  const bodyText = () => clean(document.body?.textContent || document.documentElement?.textContent || '');
  const settingsOpen = () => /General|Notifications|Personalization|Connectors|Applications|Apps/i.test(bodyText()) && /Settings|General/i.test(bodyText());
  const findText = (patterns, root = document) => nodes(root).find((node) => patterns.some((pattern) => pattern.test(textOf(node))));
  const isNativeAction = (node) => node?.matches?.('button,a,[role="button"],[role="menuitem"]');
  const isClickableLike = (node) => {
    if (!node || !(node instanceof Element) || !isVisible(node)) return false;
    const rect = node.getBoundingClientRect();
    const text = textOf(node);
    const style = getComputedStyle(node);
    return isNativeAction(node) || (style.cursor === 'pointer' && rect.width <= 360 && rect.height <= 120 && text.length <= 160);
  };
  const actionNodes = (root = document) => Array.from(root.querySelectorAll('button,a,[role="button"],[role="menuitem"],div,span')).filter(isClickableLike);
  const nearestAction = (node) => {
    let current = node;
    for (let i = 0; i < 8 && current; i += 1) {
      if (isClickableLike(current)) return current;
      current = current.parentElement;
    }
    return node;
  };
  const findAction = (patterns, root = document) => actionNodes(root).find((node) => patterns.some((pattern) => pattern.test(textOf(node))));
  const findExactTextAction = (label, root = document) => {
    const candidates = Array.from(root.querySelectorAll('button,a,[role="button"],[role="menuitem"],div,span,p'))
      .filter(isVisible)
      .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
      .filter((item) => item.text === label || item.text.startsWith(label + ' '))
      .filter((item) => item.rect.width <= 360 && item.rect.height <= 140 && item.text.length <= 180)
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    return candidates.length > 0 ? nearestAction(candidates[0].node) : null;
  };
  const findRefreshAction = (root = document) => findAction([/^refresh$/i, /\brefresh\b/i], root) || findExactTextAction('Refresh', root) || findAction([/^refresh$/i, /\brefresh\b/i]) || findExactTextAction('Refresh');
  const isEnabled = (node) => Boolean(node && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true');
  const click = async (node, label) => {
    node.scrollIntoView?.({ block: 'center', inline: 'center' });
    const previousOutline = node.style?.outline;
    const previousOutlineOffset = node.style?.outlineOffset;
    if (node.style) {
      node.style.outline = '3px solid #22c55e';
      node.style.outlineOffset = '3px';
    }
    await sleep(350);
    if (!isEnabled(node)) {
      events.push({ action: 'click-blocked', label, text: textOf(node).slice(0, 180), reason: 'disabled', href: location.href, at: new Date().toISOString() });
      if (node.style) {
        node.style.outline = previousOutline || '';
        node.style.outlineOffset = previousOutlineOffset || '';
      }
      return false;
    }
    node.focus?.({ preventScroll: true });
    node.click();
    const clickedText = textOf(node).slice(0, 180);
    events.push({ action: 'click', label, text: clickedText, href: location.href, at: new Date().toISOString() });
    await sleep(500);
    if (node.style) {
      node.style.outline = previousOutline || '';
      node.style.outlineOffset = previousOutlineOffset || '';
    }
    return true;
  };
  const waitFor = async (probe, label) => {
    const localDeadline = Math.min(deadline, Date.now() + 5000);
    let attempts = 0;
    while (Date.now() <= localDeadline && attempts < 100) {
      attempts += 1;
      const value = probe();
      if (value) return value;
      await sleep(250);
    }
    events.push({ action: 'timeout', label, attempts });
    return null;
  };

  await waitFor(() => document.readyState === 'interactive' || document.readyState === 'complete', 'document-ready');
  if (!location.href.includes(connectorId)) {
    location.href = targetUrl;
    events.push({ action: 'navigate', href: location.href, targetUrl, at: new Date().toISOString() });
    return { ok: false, status: 'CONNECTOR_SETTINGS_NAVIGATION_REQUESTED', connectorName, connectorId, href: location.href, title: document.title, events };
  }
  for (const hash of ['#settings/Connectors', '#settings/Applications', '#settings/Apps', '#settings/General']) {
    if (location.href.includes(connectorId)) break;
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
  if (!await waitFor(settingsOpen, 'settings-open')) return { ok: false, status: 'SETTINGS_NOT_OPENED', connectorName, href: location.href, title: document.title, events, diagnostics: { settingsOpen: false } };

  const tab = findExactTextAction('Connectors') || findExactTextAction('Applications') || findExactTextAction('Apps');
  if (tab) await click(tab, 'connectors-tab');
  await sleep(800);

  const escaped = connectorName.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const namePattern = new RegExp(escaped, 'i');
  const readinessSnapshot = () => { const text = bodyText(); const refresh = findRefreshAction(); const connector = findText([namePattern]); const refreshTextSeen = /\bRefresh\b/.test(text); return { ready: (namePattern.test(text) || /Console MCP/i.test(text)) && Boolean(connectorId) && (text.includes(connectorId) || location.href.includes(connectorId)) && Boolean(refresh && isVisible(refresh) && isEnabled(refresh)), connectorNameSeen: namePattern.test(text) || /Console MCP/i.test(text), connectorIdSeen: Boolean(connectorId) && (text.includes(connectorId) || location.href.includes(connectorId)), refreshTextSeen, refreshSeen: Boolean(refresh), refreshVisible: Boolean(refresh && isVisible(refresh)), refreshEnabled: Boolean(refresh && !refresh.disabled && refresh.getAttribute('aria-disabled') !== 'true'), connectorText: connector ? textOf(connector).slice(0, 300) : null, refreshText: refresh ? textOf(refresh).slice(0, 300) : null, connector, refresh }; };
  const readyState = await waitFor(() => { const state = readinessSnapshot(); events.push({ action: 'readiness', connectorNameSeen: state.connectorNameSeen, connectorIdSeen: state.connectorIdSeen, refreshTextSeen: state.refreshTextSeen, refreshSeen: state.refreshSeen, refreshVisible: state.refreshVisible, refreshEnabled: state.refreshEnabled, refreshText: state.refreshText, href: location.href, at: new Date().toISOString() }); return state.ready ? state : null; }, 'connector-page-ready');
  const connector = readyState?.connector;
  if (!readyState) { const readiness = readinessSnapshot(); delete readiness.connector; delete readiness.refresh; delete readiness.connectorText; delete readiness.refreshText; const status = readiness.connectorNameSeen && readiness.connectorIdSeen && readiness.refreshTextSeen && !readiness.refreshSeen ? 'REFRESH_TEXT_NOT_CLICKABLE' : 'CONNECTOR_PAGE_NOT_READY'; return { ok: false, status, connectorName, connectorId, href: location.href, title: document.title, events, readiness }; }
  if (!connector) { const readiness = readinessSnapshot(); delete readiness.connector; delete readiness.refresh; delete readiness.connectorText; delete readiness.refreshText; return { ok: false, status: 'CONNECTOR_NOT_FOUND', connectorName, connectorId, href: location.href, title: document.title, events, readiness }; }

  let container = connector;
  for (let i = 0; i < 8 && container?.parentElement; i += 1) {
    if (namePattern.test(textOf(container)) && /refresh|disconnect|permissions|oauth|allow/i.test(textOf(container))) break;
    container = container.parentElement;
  }
  const containerActions = actionNodes(container).map((node) => textOf(node)).filter(Boolean).slice(0, 100);
  const globalActions = actionNodes().map((node) => textOf(node)).filter(Boolean).slice(0, 200);
  const managementActions = actionNodes()
    .map((node) => textOf(node))
    .filter((text) => /refresh|disconnect|reconnect|remove|delete|uninstall|manage|permissions|oauth|connect/i.test(text))
    .slice(0, 100);
  const refresh = readyState.refresh || findRefreshAction(container) || findRefreshAction();
  if (!refresh) return { ok: false, status: 'REFRESH_BUTTON_NOT_FOUND', connectorName, href: location.href, title: document.title, events, diagnostics: { connectorContainerSeen: Boolean(container), containerActions, globalActions } };
  const clicked = await click(refresh, 'refresh');
  if (!clicked) return { ok: false, status: 'REFRESH_BUTTON_DISABLED', connectorName, connectorId, href: location.href, title: document.title, events, diagnostics: { connectorContainerSeen: Boolean(container), containerActions, globalActions, managementActions } };
  let refreshStateTransitionSeen = false;
  const transitionDeadline = Math.min(deadline, Date.now() + 15000);
  while (Date.now() <= transitionDeadline) {
    const currentRefresh = findRefreshAction(container) || findRefreshAction();
    if (!currentRefresh || !isEnabled(currentRefresh)) {
      refreshStateTransitionSeen = true;
      events.push({ action: 'refresh-state-transition', enabled: Boolean(currentRefresh && isEnabled(currentRefresh)), href: location.href, at: new Date().toISOString() });
      break;
    }
    await sleep(250);
  }
  const toast = await waitFor(() => {
    const text = bodyText();
    const success = text.match(/.{0,80}(actions refreshed|refreshed).{0,120}/i)?.[0] || null;
    if (success) return { ok: true, status: 'ACTIONS_REFRESHED' };
    const failure = text.match(/.{0,80}(error refreshing actions|something went wrong|failed to refresh|could not refresh).{0,120}/i)?.[0] || null;
    if (failure) return { ok: false, status: 'ACTIONS_REFRESH_FAILED' };
    return null;
  }, 'refresh-toast');
  const pageText = bodyText().slice(0, 20000);
  const observedTools = [...new Set([...pageText.matchAll(/\bconsole\.(?:read_|write)\.[A-Za-z0-9_.]+/g)].map((match) => match[0]))].sort();
  const catalogVisible = pageText.includes(connectorId) && /\bActions\b/i.test(pageText) && observedTools.length > 0;
  const diagnostics = { catalogVisible, observedToolCount: observedTools.length, observedTools, refreshStateTransitionSeen, containerActions, globalActions, managementActions };
  if (!toast && catalogVisible) return { ok: true, status: 'REFRESH_CLICKED_CATALOG_VISIBLE_TOAST_NOT_REQUIRED', connectorName, connectorId, href: location.href, title: document.title, events, diagnostics };
  if (!toast && refreshStateTransitionSeen) return { ok: true, status: 'REFRESH_CLICKED_STATE_TRANSITION_CONFIRMED', connectorName, connectorId, href: location.href, title: document.title, events, diagnostics };
  if (!toast) return { ok: false, status: 'REFRESH_CLICKED_TOAST_NOT_SEEN', connectorName, connectorId, href: location.href, title: document.title, events, diagnostics };
  if (!toast.ok) return { ok: false, status: toast.status, connectorName, href: location.href, title: document.title, events, diagnostics };
  return { ok: true, status: toast.status, connectorName, confirmation: toast.status, href: location.href, title: document.title, events, diagnostics };
})()`;
}

function extractRefreshClick(refreshResult) {
  const events = Array.isArray(refreshResult?.events) ? refreshResult.events : [];
  const click = events.find((event) => event?.action === 'click' && event?.label === 'refresh') ?? null;
  const strongUiConfirmed = refreshResult?.confirmation === 'ACTIONS_REFRESHED' || refreshResult?.status === 'ACTIONS_REFRESHED';
  const weakUiConfirmed = Boolean(refreshResult?.diagnostics?.refreshStateTransitionSeen)
    || refreshResult?.status === 'REFRESH_CLICKED_STATE_TRANSITION_CONFIRMED'
    || refreshResult?.status === 'REFRESH_CLICKED_CATALOG_VISIBLE_TOAST_NOT_REQUIRED'
    || refreshResult?.status === 'REFRESH_CLICKED_SCHEMA_VISIBLE_LIGHTWEIGHT'
    || refreshResult?.status === 'REFRESH_CLICKED_LIGHTWEIGHT'
    || refreshResult?.status === 'CONNECTOR_REFRESH_SKIPPED_SCHEMA_CURRENT_LIGHTWEIGHT';
  return {
    clicked: Boolean(click),
    at: click?.at ?? null,
    text: click?.text ?? null,
    ui_confirmation: strongUiConfirmed ? 'ACTIONS_REFRESHED' : (weakUiConfirmed ? String(refreshResult?.status ?? 'REFRESH_CLICKED_WEAK_UI_CONFIRMED') : null),
    ui_confirmation_strength: strongUiConfirmed ? 'strong' : (weakUiConfirmed ? 'weak' : 'none'),
    ui_confirmed: Boolean(strongUiConfirmed || weakUiConfirmed),
  };
}

function loadExpectedToolCatalog() {
  const index = JSON.parse(readFileSync(join(rootDir, "policy", "console-tool-catalog-index.json"), "utf8"));
  const names = [];
  for (const fragmentPath of Array.isArray(index.fragments) ? index.fragments : []) {
    const fragment = JSON.parse(readFileSync(join(rootDir, fragmentPath), "utf8"));
    for (const item of Array.isArray(fragment.tools) ? fragment.tools : []) {
      if (typeof item.canonicalName === "string") names.push(item.canonicalName);
      for (const alias of Array.isArray(item.canonicalReadAliases) ? item.canonicalReadAliases : []) {
        if (typeof alias === "string") names.push(alias);
      }
    }
  }
  const tools = [...new Set(names)].sort();
  return { source: "policy/console-tool-catalog-index.json", count: tools.length, tools };
}

function extractObservedToolCatalog(refreshResult) {
  const text = [
    ...(Array.isArray(refreshResult?.observedTools) ? refreshResult.observedTools : []),
    ...(Array.isArray(refreshResult?.diagnostics?.observedTools) ? refreshResult.diagnostics.observedTools : []),


  ].filter(Boolean).join(" ");
  const tools = [...new Set([...text.matchAll(/\bconsole\.(?:read_|write)\.[A-Za-z0-9_.]+/g)].map((match) => match[0]))].sort();
  const partial = text.length >= 19900;
  return { exposed: tools.length > 0, partial, count: tools.length, tools };
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
  if (observed.partial) {
    return {
      ok: null,
      status: unexpected.length === 0 ? "OBSERVED_TOOLS_PARTIAL_SAMPLE" : "OBSERVED_TOOLS_PARTIAL_SAMPLE_HAS_UNEXPECTED",
      expected_count: expected.count,
      observed_count: observed.count,
      missing_count: null,
      unexpected_count: unexpected.length,
      partial: true,
      unexpected,
    };
  }
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

async function cleanupBrowserTargetsAcrossPorts(candidatePorts, timeout, phase) {
  const attempts = [];
  for (const port of [...new Set(candidatePorts)]) {
    try {
      const result = await cleanupBrowserTargets(port, Math.min(timeout, 10000), phase);
      return { ...result, attempts };
    } catch (error) {
      attempts.push({ port, ok: false, error: sanitize(error) });
    }
  }
  return {
    ok: false,
    status: "BROWSER_LIFECYCLE_CLEANUP_DEVTOOLS_UNAVAILABLE",
    phase,
    ports: candidatePorts,
    attempts,
  };
}

async function cleanupBrowserTargets(port, timeout, phase) {
  const before = await devtoolsJson(port, "/json/list", "GET", timeout);
  if (!Array.isArray(before)) throw new Error(`DevTools target list on ${port} was not an array.`);

  const preferred = chooseCleanupKeeper(before);
  if (preferred?.id) {
    await devtoolsText(port, `/json/activate/${encodeURIComponent(preferred.id)}`, "GET", timeout).catch(() => undefined);
    await sleep(200);
  }

  const current = await devtoolsJson(port, "/json/list", "GET", timeout);
  const plan = buildBrowserCleanupPlan(Array.isArray(current) ? current : [], preferred?.id ?? null);
  const closed = [];
  const failed = [];
  for (const target of plan.selected.slice(0, 50)) {
    try {
      await devtoolsText(port, `/json/close/${encodeURIComponent(target.id)}`, "GET", timeout);
      closed.push({ id: target.id, category: target.category });
    } catch (error) {
      failed.push({ id: target.id, category: target.category, error: sanitize(error) });
    }
  }

  const after = await devtoolsJson(port, "/json/list", "GET", timeout);
  return {
    ok: failed.length === 0,
    status: failed.length === 0 ? "BROWSER_LIFECYCLE_CLEANUP_COMPLETED" : "BROWSER_LIFECYCLE_CLEANUP_PARTIAL",
    phase,
    port,
    preferred_target_id: preferred?.id ?? null,
    before: summarizeBrowserTargets(before),
    planned: {
      settings_count: plan.settings.length,
      empty_home_count: plan.emptyHomes.length,
      duplicate_chat_count: plan.duplicateChats.length,
      selected_count: plan.selected.length,
    },
    closed_count: closed.length,
    closed,
    failed_count: failed.length,
    failed,
    after: summarizeBrowserTargets(Array.isArray(after) ? after : []),
    policy: {
      chatgpt_host_only: true,
      settings_only: true,
      empty_home_only: true,
      duplicate_chat_only: true,
      preserves_preferred_chat_or_root: true,
      max_close: 50,
    },
  };
}

function buildBrowserCleanupPlan(targets, preferredTargetId) {
  const pages = targets.filter((target) => target?.type === "page" && target.id && isChatGptTargetUrl(target.url));
  const settings = pages.filter((target) => target.id !== preferredTargetId && isChatGptSettingsUrl(target.url));
  const emptyHomes = pages.filter((target) => target.id !== preferredTargetId && isEmptyChatGptHomeUrl(target.url));
  const groups = new Map();
  for (const target of pages) {
    const chatId = extractChatGptTargetId(target.url);
    if (!chatId) continue;
    const group = groups.get(chatId) ?? [];
    group.push(target);
    groups.set(chatId, group);
  }

  const duplicateChats = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = group.find((target) => target.id === preferredTargetId) ?? group[0];
    for (const target of group) {
      if (target.id !== keeper.id) duplicateChats.push(target);
    }
  }

  const selected = [
    ...settings.map((target) => ({ ...target, category: "plugin_or_connector_settings" })),
    ...emptyHomes.map((target) => ({ ...target, category: "empty_chatgpt_home" })),
    ...duplicateChats.map((target) => ({ ...target, category: "duplicate_chat" })),
  ].filter((target, index, items) => items.findIndex((item) => item.id === target.id) === index);

  return { settings, emptyHomes, duplicateChats, selected };
}

function chooseCleanupKeeper(targets) {
  const pages = targets.filter((target) => target?.type === "page" && target.id && isChatGptTargetUrl(target.url));
  return pages.find((target) => Boolean(extractChatGptTargetId(target.url)))
    ?? pages.find((target) => isEmptyChatGptHomeUrl(target.url))
    ?? pages.find((target) => !isChatGptSettingsUrl(target.url))
    ?? null;
}

function summarizeBrowserTargets(targets) {
  const pages = targets.filter((target) => target?.type === "page" && isChatGptTargetUrl(target.url));
  const chatIds = pages.map((target) => extractChatGptTargetId(target.url)).filter(Boolean);
  return {
    target_count: targets.length,
    chatgpt_page_count: pages.length,
    settings_count: pages.filter((target) => isChatGptSettingsUrl(target.url)).length,
    empty_home_count: pages.filter((target) => isEmptyChatGptHomeUrl(target.url)).length,
    chat_count: chatIds.length,
    duplicate_chat_count: chatIds.length - new Set(chatIds).size,
  };
}

function isChatGptTargetUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    return url.protocol === "https:" && url.hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

function isChatGptSettingsUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    if (!isChatGptTargetUrl(rawUrl)) return false;
    return /^#settings\/(?:Plugins\/plugin_[A-Za-z0-9_-]+|Connectors(?:\?|$)|Applications(?:\?|$)|Apps(?:\?|$))/u.test(url.hash);
  } catch {
    return false;
  }
}

function isEmptyChatGptHomeUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    return isChatGptTargetUrl(rawUrl) && url.pathname === "/" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function extractChatGptTargetId(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    if (!isChatGptTargetUrl(rawUrl)) return null;
    const match = url.pathname.match(/^\/(?:c|chat)\/([A-Za-z0-9-]+)(?:\/|$)/u);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
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

