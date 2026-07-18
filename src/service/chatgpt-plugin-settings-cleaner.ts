import { request } from "node:http";

export type ChatGptPluginSettingsCleanupOptions = {
  ports?: number[];
  timeoutMs?: number;
  maxClose?: number;
  keepTargetId?: string;
};

type BrowserDebugTarget = {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type TargetRecord = BrowserDebugTarget & { port: number };
type InventoryResult = { targets: TargetRecord[]; attempts: Array<Record<string, unknown>> };
type DevToolsWebSocket = {
  onopen: null | (() => void);
  onerror: null | ((event: unknown) => void);
  onmessage: null | ((event: { data: unknown }) => void);
  close: () => void;
  send: (data: string) => void;
};
type DevToolsWebSocketConstructor = new (url: string) => DevToolsWebSocket;

const DEFAULT_PORTS = [9222, 9223];
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_CLOSE = 10;

export async function cleanupChatGptPluginSettingsTargets(input: ChatGptPluginSettingsCleanupOptions = {}): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const ports = normalizePorts(input.ports);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const maxClose = normalizeMaxClose(input.maxClose);
  const before = await collectTargets(ports, timeoutMs);
  const candidates = selectCandidates(before.targets, maxClose, input.keepTargetId);
  const closed: Array<Record<string, unknown>> = [];

  for (const candidate of candidates) {
    const liveTarget = await findLiveTarget(candidate.port, candidate.id ?? "", timeoutMs);
    if (!liveTarget) {
      closed.push({ ok: false, status: "PLUGIN_SETTINGS_TARGET_NOT_RESOLVED", target: compactTarget(candidate), closed: false });
      continue;
    }
    if (!isChatGptPluginSettingsUrl(liveTarget.url ?? "")) {
      closed.push({ ok: true, status: "PLUGIN_SETTINGS_TARGET_URL_CHANGED", target: compactTarget(liveTarget), closed: false, protected: true });
      continue;
    }
    const activity = await inspectTargetActivity(liveTarget, timeoutMs);
    if (activity.protected === true) {
      closed.push({ ok: true, status: "ACTIVE_BROWSER_TAB_PRESERVED", target: compactTarget(liveTarget), activity, closed: false });
      continue;
    }

    try {
      await devToolsTextRequest(candidate.port, `/json/close/${encodeURIComponent(candidate.id ?? "")}`, "GET", timeoutMs);
      closed.push({ ok: true, status: "TARGET_CLOSE_REQUESTED", target: compactTarget(liveTarget), closed: true });
    } catch (error) {
      closed.push({ ok: false, status: "TARGET_CLOSE_FAILED", target: compactTarget(liveTarget), closed: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const after = await collectTargets(ports, timeoutMs);
  const remaining = selectCandidates(after.targets, 50, input.keepTargetId);
  const targetFailureCount = closed.filter((item) => item.ok !== true).length;
  const inventoryFailureCount = countInventoryFailures(before) + countInventoryFailures(after);
  const failedCount = targetFailureCount + inventoryFailureCount;
  const closedCount = closed.filter((item) => item.closed === true).length;
  const preservedActiveCount = closed.filter((item) => item.status === "ACTIVE_BROWSER_TAB_PRESERVED").length;

  return {
    ok: failedCount === 0,
    status: failedCount === 0 ? "CHATGPT_PLUGIN_SETTINGS_HOUSEKEEPING_DONE" : "CHATGPT_PLUGIN_SETTINGS_HOUSEKEEPING_PARTIAL",
    ports,
    duration_ms: Date.now() - startedAt,
    plugin_settings_candidate_count_before: candidates.length,
    requested_close_count: candidates.length,
    closed_count: closedCount,
    preserved_active_count: preservedActiveCount,
    target_failed_count: targetFailureCount,
    inventory_failed_count: inventoryFailureCount,
    failed_count: failedCount,
    plugin_settings_candidate_count_after: remaining.length,
    closed,
    attempts_before: before.attempts,
    attempts_after: after.attempts,
  };
}

export async function previewChatGptPluginSettingsTargets(input: ChatGptPluginSettingsCleanupOptions = {}): Promise<Record<string, unknown>> {
  const ports = normalizePorts(input.ports);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const maxClose = normalizeMaxClose(input.maxClose);
  const inventory = await collectTargets(ports, timeoutMs);
  const candidates = selectCandidates(inventory.targets, maxClose, input.keepTargetId);
  const inventoryFailureCount = countInventoryFailures(inventory);
  return {
    ok: inventoryFailureCount === 0,
    status: inventoryFailureCount === 0 ? "CHATGPT_PLUGIN_SETTINGS_HOUSEKEEPING_PREVIEW_READY" : "CHATGPT_PLUGIN_SETTINGS_HOUSEKEEPING_PREVIEW_PARTIAL",
    ports,
    plugin_settings_candidate_count: candidates.length,
    selected_count: candidates.length,
    max_selected_count: maxClose,
    inventory_failed_count: inventoryFailureCount,
    details_omitted: true,
    attempts: inventory.attempts,
  };
}

export function isChatGptPluginSettingsUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "chatgpt.com" && host !== "www.chatgpt.com")) return false;
    return /^#settings\/Plugins\/plugin_[A-Za-z0-9_-]+(?:[/?].*)?$/u.test(url.hash);
  } catch {
    return false;
  }
}

function normalizePorts(ports?: number[]): number[] {
  const values = ports && ports.length > 0 ? ports : DEFAULT_PORTS;
  return [...new Set(values)].filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535);
}

function normalizeTimeout(timeoutMs?: number): number {
  return Number.isInteger(timeoutMs) ? Math.min(Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, 250), 10000) : DEFAULT_TIMEOUT_MS;
}

function normalizeMaxClose(maxClose?: number): number {
  return Number.isInteger(maxClose) ? Math.min(Math.max(maxClose ?? DEFAULT_MAX_CLOSE, 1), 50) : DEFAULT_MAX_CLOSE;
}

async function collectTargets(ports: number[], timeoutMs: number): Promise<InventoryResult> {
  const targets: TargetRecord[] = [];
  const attempts: Array<Record<string, unknown>> = [];
  for (const port of ports) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const list = JSON.parse(raw) as BrowserDebugTarget[];
      const pages = (Array.isArray(list) ? list : []).filter((target) => target.type === "page" && typeof target.id === "string");
      targets.push(...pages.map((target) => ({ ...target, port })));
      attempts.push({ port, ok: true, target_count: pages.length });
    } catch (error) {
      attempts.push({ port, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { targets, attempts };
}

function countInventoryFailures(inventory: InventoryResult): number {
  return inventory.attempts.filter((attempt) => attempt.ok !== true).length;
}

function selectCandidates(targets: TargetRecord[], maxClose: number, keepTargetId?: string): TargetRecord[] {
  return targets
    .filter((target) => Boolean(target.id) && target.id !== keepTargetId && isChatGptPluginSettingsUrl(target.url ?? ""))
    .slice(0, maxClose);
}

async function findLiveTarget(port: number, targetId: string, timeoutMs: number): Promise<TargetRecord | null> {
  if (!targetId) return null;
  try {
    const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
    const list = JSON.parse(raw) as BrowserDebugTarget[];
    const target = (Array.isArray(list) ? list : []).find((candidate) => candidate.id === targetId && candidate.type === "page");
    return target ? { ...target, port } : null;
  } catch {
    return null;
  }
}

async function inspectTargetActivity(target: TargetRecord, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!target.webSocketDebuggerUrl) return { protected: true, status: "TARGET_ACTIVITY_UNRESOLVED", reason: "websocket_missing" };
  try {
    const result = await evaluateTarget(target.webSocketDebuggerUrl, "({ visibilityState: document.visibilityState, hasFocus: document.hasFocus() })", timeoutMs);
    const value = asRecord(result);
    const visible = value.visibilityState === "visible";
    const focused = value.hasFocus === true;
    return { protected: visible || focused, status: visible || focused ? "TARGET_ACTIVE" : "TARGET_INACTIVE", visibility_state: value.visibilityState ?? null, has_focus: focused };
  } catch (error) {
    return { protected: true, status: "TARGET_ACTIVITY_UNRESOLVED", reason: error instanceof Error ? error.message : String(error) };
  }
}

function evaluateTarget(webSocketUrl: string, expression: string, timeoutMs: number): Promise<unknown> {
  const WebSocketConstructor = (globalThis as typeof globalThis & { WebSocket?: DevToolsWebSocketConstructor }).WebSocket;
  if (!WebSocketConstructor) return Promise.reject(new Error("WebSocket is unavailable in this Node runtime"));
  return new Promise((resolve, reject) => {
    const socket = new WebSocketConstructor(webSocketUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try { socket.close(); } catch { }
      reject(new Error("DevTools activity inspection timed out"));
    }, timeoutMs);
    socket.onerror = () => {
      clearTimeout(timer);
      try { socket.close(); } catch { }
      reject(new Error("DevTools activity inspection failed"));
    };
    socket.onopen = () => socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown } }; error?: unknown };
        if (payload.id !== id) return;
        clearTimeout(timer);
        socket.close();
        if (payload.error) reject(new Error(JSON.stringify(payload.error)));
        else resolve(payload.result?.result?.value);
      } catch (error) {
        clearTimeout(timer);
        try { socket.close(); } catch { }
        reject(error);
      }
    };
  });
}

function devToolsTextRequest(port: number, pathname: string, method: "GET", timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: pathname, method, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`DevTools request failed with HTTP ${res.statusCode}: ${body}`));
        else resolve(body);
      });
    });
    req.on("timeout", () => req.destroy(new Error("DevTools request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function compactTarget(target: TargetRecord): Record<string, unknown> {
  return { port: target.port, id: target.id ?? null, type: target.type ?? null, title: target.title ?? null, url: target.url ?? null, has_web_socket_debugger_url: Boolean(target.webSocketDebuggerUrl) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
