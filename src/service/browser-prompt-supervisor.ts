// Central, read-only browser prompt observation. No automatic dismiss, reload or restart.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
export type BrowserPromptObservation = {
  status: "DETECTED" | "NOT_OBSERVED" | "UNOBSERVABLE";
  kind: "JAVASCRIPT_DIALOG" | "UNKNOWN";
  targetId: string | null;
  dialogType: string | null;
  resolution: "MANUAL_REVIEW" | "NO_ACTION" | "INSUFFICIENT_EVIDENCE";
  source: "CDP_PAGE_EVENT";
};
type BrowserTarget = { id?: string; type?: string; webSocketDebuggerUrl?: string };
const safePort = (port: number) => Number.isInteger(port) && port > 0 && port < 65536;

export async function inspectBrowserPrompts(port = 9223, timeoutMs = 1200, browserPid?: number): Promise<{
  ok: boolean; status: string; observations: BrowserPromptObservation[];
  browserChromePrompts: "UNOBSERVABLE" | "SUSPECTED"; chromeObservations?: Array<{ kind: string; window_id: string; action: string }>;
  mutationAttempted: false;
}> {
  const none: BrowserPromptObservation = { status: "UNOBSERVABLE", kind: "UNKNOWN", targetId: null,
    dialogType: null, resolution: "INSUFFICIENT_EVIDENCE", source: "CDP_PAGE_EVENT" };
  if (!safePort(port)) return { ok: false, status: "BROWSER_PROMPT_PORT_INVALID", observations: [none], browserChromePrompts: "UNOBSERVABLE", mutationAttempted: false };
  const boundedMs = Math.max(200, Math.min(3000, Math.trunc(timeoutMs)));
  let targets: BrowserTarget[];
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(boundedMs) });
    if (!response.ok) throw Error("CDP target listing failed");
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw Error("Invalid CDP targets");
    targets = value.filter((v): v is BrowserTarget => !!v && typeof v === "object" && v.type === "page"
      && typeof v.id === "string" && /^[0-9a-fA-F]{32}$/.test(v.id)
      && typeof v.webSocketDebuggerUrl === "string"
      && v.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/devtools/page/`)).slice(0, 4);
  } catch {
    return { ok: false, status: "BROWSER_PROMPT_CDP_UNAVAILABLE", observations: [none], browserChromePrompts: "UNOBSERVABLE", mutationAttempted: false };
  }
  if (!targets.length) return { ok: false, status: "BROWSER_PROMPT_NO_PAGE_TARGET", observations: [none], browserChromePrompts: "UNOBSERVABLE", mutationAttempted: false };
  const observations = await Promise.all(targets.map(t => observePageDialog(t, boundedMs)));
  const chrome = process.platform === "win32" && Number.isInteger(browserPid) && browserPid! > 0
    ? await observeChromeUi(browserPid!, boundedMs) : null;
  return { ok: observations.some(o => o.status !== "UNOBSERVABLE") || !!chrome?.length,
    status: observations.some(o => o.status === "DETECTED") ? "BROWSER_PROMPT_DETECTED" :
      observations.some(o => o.status === "NOT_OBSERVED") ? "BROWSER_PROMPT_NOT_OBSERVED" : "BROWSER_PROMPT_OBSERVATION_UNAVAILABLE",
    observations, browserChromePrompts: chrome?.length ? "SUSPECTED" : "UNOBSERVABLE",
    chromeObservations: chrome ?? [], mutationAttempted: false };
}

async function observeChromeUi(pid: number, timeoutMs: number): Promise<Array<{ kind: string; window_id: string; action: string }> | null> {
  if (process.platform !== "win32") return null;
  const script = fileURLToPath(new URL("../../tool/browser-chrome-prompt-inspect.ps1", import.meta.url));
  return new Promise(resolve => {
    execFile("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, "-BrowserPid", String(pid)],
      { timeout: Math.max(1500, Math.min(7000, timeoutMs + 3500)), maxBuffer: 16384 }, (error, stdout) => {
        if (error) { resolve(null); return; }
        try {
          const value: unknown = JSON.parse(stdout);
          if (!value || typeof value !== "object") { resolve(null); return; }
          const data = value as { ok?: boolean; observations?: Array<{ kind?: unknown; window_id?: unknown; action?: unknown }> };
          if (!data.ok || !Array.isArray(data.observations)) { resolve(null); return; }
          resolve(data.observations.filter(item => typeof item.kind === "string" && typeof item.window_id === "string"
            && item.action === "MANUAL_REVIEW") as Array<{ kind: string; window_id: string; action: string }>);
        } catch { resolve(null); }
      });
  });
}

function observePageDialog(target: BrowserTarget, timeoutMs: number): Promise<BrowserPromptObservation> {
  const defaultResult: BrowserPromptObservation = { status: "UNOBSERVABLE", kind: "UNKNOWN", targetId: target.id ?? null,
    dialogType: null, resolution: "INSUFFICIENT_EVIDENCE", source: "CDP_PAGE_EVENT" };
  return new Promise(resolve => {
    const ws = new WebSocket(target.webSocketDebuggerUrl!);
    let done = false;
    let enabled = false;
    const finish = (observation: BrowserPromptObservation) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* connection may already be closed */ }
      resolve(observation);
    };
    const timer = setTimeout(() => finish(enabled
      ? { ...defaultResult, status: "NOT_OBSERVED", resolution: "NO_ACTION" } : defaultResult), timeoutMs);
    ws.addEventListener("open", () => {
      try { ws.send(JSON.stringify({ id: 1, method: "Page.enable" })); } catch { finish(defaultResult); }
    });
    ws.addEventListener("message", event => {
      try {
        const data: unknown = JSON.parse(String(event.data));
        if (!data || typeof data !== "object") return;
        const message = data as { id?: number; error?: unknown; method?: string; params?: { type?: string } };
        if (message.id === 1) {
          if (message.error) finish(defaultResult);
          else enabled = true;
        }
        if (message.method === "Page.javascriptDialogOpening") {
          finish({ ...defaultResult, status: "DETECTED", kind: "JAVASCRIPT_DIALOG",
            dialogType: typeof message.params?.type === "string" ? message.params.type : "unknown",
            resolution: "MANUAL_REVIEW" });
        }
      } catch { /* unrecognized CDP event */ }
    });
    ws.addEventListener("error", () => finish(defaultResult));
    ws.addEventListener("close", () => finish(defaultResult));
  });
}
