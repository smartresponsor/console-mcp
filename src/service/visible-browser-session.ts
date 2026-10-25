import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
export const visibleSessionStates = ["CDP_CONNECTED", "BROWSER_TARGET_EXISTS", "BROWSER_PROCESS_RUNNING", "GUI_SESSION_IDENTIFIED", "VISIBLE_WINDOW_VERIFIED", "VISIBLE_TARGET_BOUND", "USER_INTERACTION_READY"] as const;
export type VisibleSessionEvidence = {
  host: string; os: string; runtimeOwner: "console-mcp"; interactiveUser: string | null;
  userId: number | string | null; guiSessionId: string | null; browserPid: number | null;
  processStartedAt: string | null; profile: string | null; display: string | null;
  windowId: string | null; cdpWindowId: number | null; endpoint: string; browserInstance: string | null;
  targetId: string | null; verifiedAt: string | null; x11Diagnostic?: { stage: string; candidateCount?: number; matchedCount?: number; activeWindowFound?: boolean; activeWindowPresent?: boolean; browserPidWindowCount?: number; activeWindowIsBrowser?: boolean };
};
export type VisibleSessionResult = {
  ok: boolean; status: string; reason: string; states: string[]; evidence: VisibleSessionEvidence;
  correlationId: string; visibility_verified: boolean; user_interaction_ready: boolean;
  resolution_candidates?: { reason: string; evidence: VisibleSessionEvidence }[];
  page_authentication_observation: "LOGIN_UI_PRESENT" | "NOT_DETECTED" | "NOT_CHECKED";
};
export type VisibleFacts = {
  cdp: boolean; target: boolean; process: boolean; gui: boolean; window: boolean;
  headless: boolean; sameUser: boolean; sameDisplay: boolean; sameWindow: boolean;
  locked: boolean; ambiguous: boolean; authenticationRequired?: boolean;
};
export function classifyVisibleSession(f: VisibleFacts): string | null {
  if (!f.cdp) return "SESSION_UNAVAILABLE";
  if (!f.target) return "BROWSER_TARGET_STALE";
  if (!f.process) return "VISIBILITY_UNKNOWN";
  if (f.headless) return "SESSION_NOT_VISIBLE";
  if (!f.gui) return "GUI_SESSION_UNAVAILABLE";
  if (f.ambiguous) return "AMBIGUOUS_VISIBLE_SESSIONS";
  if (!f.sameUser || !f.sameDisplay) return "TARGET_BELONGS_TO_ANOTHER_SESSION";
  if (f.locked) return "SESSION_NOT_VISIBLE";
  if (!f.window || !f.sameWindow) return "VISIBILITY_UNKNOWN";
  return null;
}
export function sameVisibleRuntime(a: VisibleSessionEvidence, b: VisibleSessionEvidence): boolean {
  return ["host", "os", "userId", "guiSessionId", "browserPid", "processStartedAt", "profile", "display", "endpoint", "browserInstance"].every(key => a[key as keyof VisibleSessionEvidence] !== null && a[key as keyof VisibleSessionEvidence] === b[key as keyof VisibleSessionEvidence]);
}
function result(evidence: VisibleSessionEvidence, facts: VisibleFacts, correlationId: string): VisibleSessionResult {
  const reason = classifyVisibleSession(facts);
  const states = [facts.cdp && "CDP_CONNECTED", facts.target && "BROWSER_TARGET_EXISTS", facts.process && "BROWSER_PROCESS_RUNNING", facts.gui && "GUI_SESSION_IDENTIFIED", facts.window && facts.sameWindow && "VISIBLE_WINDOW_VERIFIED", !reason && "VISIBLE_TARGET_BOUND", !reason && "USER_INTERACTION_READY"].filter((v): v is string => Boolean(v));
  return { ok: !reason, status: !reason ? "VISIBLE_TARGET_BOUND" : "WEB_VISIBLE_SESSION_REQUIRED", reason: reason ?? "VERIFIED", states, evidence: { ...evidence, verifiedAt: !reason ? new Date().toISOString() : null }, correlationId, visibility_verified: !reason, user_interaction_ready: !reason,
    // A visible login form describes the web page, not the Windows session.
    // It must not suppress read-only inspection or safe provider navigation.
    page_authentication_observation: facts.authenticationRequired === true ? "LOGIN_UI_PRESENT" : facts.authenticationRequired === false ? "NOT_DETECTED" : "NOT_CHECKED" };
}
function invalidate(session: VisibleSessionResult, reason: string): VisibleSessionResult {
  return { ...session, ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", reason,
    states: session.states.filter(state => !["VISIBLE_TARGET_BOUND", "USER_INTERACTION_READY"].includes(state)),
    evidence: { ...session.evidence, verifiedAt: null }, visibility_verified: false, user_interaction_ready: false };
}
export function assertVisibleSession(session: VisibleSessionResult): void {
  if (session.ok) return;
  throw Object.assign(new Error(session.reason), { status: session.status, visibleSession: session });
}
async function command(bin: string, args: string[], env = process.env): Promise<string> {
  return (await exec(bin, args, { timeout: 2500, maxBuffer: 1024 * 1024, env })).stdout.trim();
}
const properties = (text: string): Record<string, string> => Object.fromEntries(text.split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
async function json(endpoint: string, route: string): Promise<any> {
  const response = await fetch(endpoint + route, { signal: AbortSignal.timeout(2500), redirect: "error" });
  if (!response.ok) throw new Error("CDP unavailable");
  return response.json();
}
export async function visibleCdpCommand(url: string, method: string, params: Record<string, unknown> = {}, nativeFocus = false): Promise<any> {
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("Cross-host CDP is not authorized");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("CDP verification timeout")), 2500);
    const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value); };
    socket.addEventListener("open", () => socket.send(JSON.stringify(nativeFocus
      ? { id: 0, method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } }
      : { id: 1, method, params })));
    socket.addEventListener("error", () => finish(new Error("CDP verification failed")));
    socket.addEventListener("message", event => { try { const data = JSON.parse(String(event.data)); if (nativeFocus && data.id === 0) { if (data.error) finish(new Error("Native focus evidence unavailable")); else socket.send(JSON.stringify({ id: 1, method, params })); } if (data.id === 1) finish(data.error ? new Error("CDP evidence unavailable") : undefined, data.result); } catch { finish(new Error("Invalid CDP evidence")); } });
  });
}
async function linuxEvidence(port: number, e: VisibleSessionEvidence, f: VisibleFacts, bounds: any, background = false): Promise<void> {
  const sessions = (await command("loginctl", ["list-sessions", "--no-legend"])).split("\n").map(line => line.trim().split(/\s+/)[0]).filter(id => /^[\w-]+$/.test(id));
  const eligible: Record<string, string>[] = [];
  for (const id of sessions) {
    const s = properties(await command("loginctl", ["show-session", id, "-p", "Id", "-p", "User", "-p", "Name", "-p", "Type", "-p", "Active", "-p", "Remote", "-p", "Class", "-p", "LockedHint"]));
    if (s.Active === "yes" && s.Remote === "no" && s.Class === "user" && ["x11", "wayland"].includes(s.Type)) eligible.push(s);
  }
  const intended = process.env.CONSOLE_MCP_INTERACTIVE_USER;
  const selected = intended ? eligible.filter(s => s.Name === intended) : eligible;
  f.ambiguous = selected.length > 1;
  f.gui = selected.length === 1;
  if (!f.gui) return;
  const s = selected[0]; e.interactiveUser = s.Name; e.userId = Number(s.User); e.guiSessionId = s.Id; f.locked = s.LockedHint !== "no";
  // Join the actual listening socket inode to a browser PID; a command-line port is not proof.
  const tables = await Promise.all(["tcp", "tcp6"].map(n => readFile(`/proc/net/${n}`, "utf8").catch(() => "")));
  const inodes = new Set(tables.flatMap(text => text.split("\n").slice(1).map(line => line.trim().split(/\s+/)).filter(cols => cols[3] === "0A" && parseInt(cols[1]?.split(":")[1], 16) === port).map(cols => cols[9])));
  const owners: { pid: number; args: string[]; uid: number }[] = [];
  for (const id of (await readdir("/proc")).filter(id => /^\d+$/.test(id))) {
    try {
      const raw = (await readFile(`/proc/${id}/cmdline`, "utf8")).replace(/\0+$/, "");
      // Edge rewrites argv into a single process-title string after moving to its app scope.
      const args = raw.includes("\0") ? raw.split("\0") : raw.split(/\s+/);
      if (args.some(arg => arg.startsWith("--type=")) || !/(chrome|chromium|msedge|microsoft-edge)/.test(args[0])) continue;
      const fds = await readdir(`/proc/${id}/fd`);
      const links = await Promise.all(fds.map(fd => readlink(`/proc/${id}/fd/${fd}`).catch(() => "")));
      if (links.some(link => inodes.has(link.match(/^socket:\[(\d+)\]$/)?.[1] ?? ""))) owners.push({ pid: Number(id), args, uid: (await stat(`/proc/${id}`)).uid });
    } catch { /* inaccessible evidence cannot authorize a session */ }
  }
  if (owners.length !== 1) return;
  const p = owners[0]; e.browserPid = p.pid; f.process = true; f.headless = p.args.some(arg => arg.startsWith("--headless")); f.sameUser = p.uid === e.userId;
  const procStat = await readFile(`/proc/${p.pid}/stat`, "utf8"); e.processStartedAt = procStat.slice(procStat.lastIndexOf(")") + 2).split(" ")[19];
  const profileArg = p.args.find(arg => arg.startsWith("--user-data-dir=")); e.profile = profileArg?.slice("--user-data-dir=".length) ?? null;
  if (!f.sameUser || f.headless) return;
  if (port === 9224 && (e.profile !== "/home/alex/.config/console-mcp-edge-visible" ||
      await readlink(`/proc/${p.pid}/exe`) !== "/opt/microsoft/msedge/msedge")) { f.process = false; return; }
  const penv = Object.fromEntries((await readFile(`/proc/${p.pid}/environ`, "utf8")).split("\0").map(v => { const i = v.indexOf("="); return [v.slice(0, i), v.slice(i + 1)]; }));
  const cgroup = await readFile(`/proc/${p.pid}/cgroup`, "utf8");
  // Display plus membership in the intended logind scope is required. Xvfb/service displays fail here.
  f.sameDisplay = cgroup.includes(`/session-${s.Id}.scope`) || (
    process.env.CONSOLE_MCP_DESKTOP_LOCAL === "1" && process.getuid?.() === 1000 &&
    cgroup.includes("/user-1000.slice/user@1000.service/") &&
    (cgroup.endsWith("/console-mcp-visible-edge.service\n") || cgroup.endsWith(`/app-org.chromium.Chromium-${p.pid}.scope\n`)) &&
    e.profile === "/home/alex/.config/console-mcp-edge-visible" &&
    (!penv.DISPLAY || penv.DISPLAY === process.env.DISPLAY) &&
    (!penv.XAUTHORITY || penv.XAUTHORITY === process.env.XAUTHORITY));
  e.display = penv.DISPLAY || (process.env.CONSOLE_MCP_DESKTOP_LOCAL === "1" && port === 9224 ? process.env.DISPLAY ?? null : null);
  if (!f.sameDisplay || s.Type !== "x11" || !e.display || !e.profile) { e.x11Diagnostic = { stage: "display_or_profile_mismatch" }; return; }
  if (background) { f.window = true; f.sameWindow = true; return; }
  const xenv = { ...process.env, DISPLAY: e.display, XAUTHORITY: penv.XAUTHORITY || (process.env.CONSOLE_MCP_DESKTOP_LOCAL === "1" && port === 9224 ? process.env.XAUTHORITY ?? "" : "") };
  const resources = await command("xrdb", ["-query"], xenv);
  const dpi = Number(resources.match(/^Xft\.dpi:\s*([0-9.]+)$/m)?.[1] ?? 96);
  const scale = dpi / 96;
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) { e.x11Diagnostic = { stage: "invalid_dpi" }; return; }
  const root = await command("xprop", ["-root", "_NET_CLIENT_LIST", "_NET_CURRENT_DESKTOP", "_NET_ACTIVE_WINDOW"], xenv);
  const desktop = root.match(/_NET_CURRENT_DESKTOP.*= (\d+)/)?.[1];
  const ids = root.split("\n").find(line => line.startsWith("_NET_CLIENT_LIST"))?.match(/0x[0-9a-f]+/gi) ?? [];
  const active = root.match(/_NET_ACTIVE_WINDOW[^\n]*?\b(0x[0-9a-f]+)\b/i)?.[1];
  const matched: string[] = [];
  e.x11Diagnostic = { stage: "window_matching", candidateCount: ids.length, activeWindowFound: Boolean(active && ids.some(id => id.toLowerCase() === active.toLowerCase())), activeWindowPresent: Boolean(active), browserPidWindowCount: 0, activeWindowIsBrowser: false };
  for (const id of ids) {
    const props = await command("xprop", ["-id", id, "_NET_WM_PID", "_NET_WM_STATE", "_NET_WM_DESKTOP", "_NET_FRAME_EXTENTS"], xenv);
    if (Number(props.match(/_NET_WM_PID.*= (\d+)/)?.[1]) === p.pid) {
      e.x11Diagnostic.browserPidWindowCount = (e.x11Diagnostic.browserPidWindowCount ?? 0) + 1;
      if (id.toLowerCase() === active?.toLowerCase()) e.x11Diagnostic.activeWindowIsBrowser = true;
    }
    if (id.toLowerCase() !== active?.toLowerCase()) continue;
    if (Number(props.match(/_NET_WM_PID.*= (\d+)/)?.[1]) !== p.pid || /_NET_WM_STATE_HIDDEN/.test(props)) continue;
    const wd = props.match(/_NET_WM_DESKTOP.*= (\d+)/)?.[1];
    if (!desktop || !wd || (wd !== desktop && wd !== "4294967295")) continue;
    const info = await command("xwininfo", ["-id", id], xenv);
    if (!/Map State: IsViewable/.test(info)) continue;
    const number = (label: string) => Number(info.match(new RegExp(label + ":\\s+(-?\\d+)"))?.[1]);
    const ext = props.match(/_NET_FRAME_EXTENTS.*= (\d+), (\d+), (\d+), (\d+)/)?.slice(1).map(Number) ?? [0, 0, 0, 0];
    if (number("Absolute upper-left X") - ext[0] === Math.round(bounds.left * scale) && number("Absolute upper-left Y") - ext[2] === Math.round(bounds.top * scale) && number("Width") + ext[0] + ext[1] === Math.round(bounds.width * scale) && number("Height") + ext[2] + ext[3] === Math.round(bounds.height * scale)) matched.push(id);
  }
  f.window = matched.length === 1 && bounds.windowState !== "minimized"; f.sameWindow = f.window;
  e.x11Diagnostic.matchedCount = matched.length;
  e.x11Diagnostic.stage = f.window ? "matched" : "window_mismatch";
  if (f.window) e.windowId = matched[0];
}
async function windowsEvidence(port: number, e: VisibleSessionEvidence, f: VisibleFacts, bounds: any): Promise<void> {
  const script = fileURLToPath(new URL("../../tool/visible-browser-native-windows.ps1", import.meta.url));
  const native = JSON.parse((await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-Port", String(port)], { timeout: 8000, maxBuffer: 1024 * 1024 })).stdout);
  if (!/^(chrome|msedge|chromium)$/i.test(native.name)) return;
  e.browserPid = native.pid; e.processStartedAt = native.startedAt; e.profile = native.profile || null;
  e.userId = native.userSid ?? null; e.interactiveUser = native.user; e.guiSessionId = String(native.sessionId); e.display = "WinSta0/Default";
  f.process = true; f.headless = native.headless === true; f.gui = native.sessionId > 0;
  f.sameUser = native.sameUser === true; f.sameDisplay = native.sameSession === true; f.locked = native.inputReady !== true;
  const matched = native.windows.filter((w: any) => w.left === bounds.left && w.top === bounds.top && w.width === bounds.width && w.height === bounds.height);
  f.window = matched.length === 1 && bounds.windowState !== "minimized"; f.sameWindow = f.window;
  if (f.window) e.windowId = matched[0].id;
}
export async function inspectVisibleTarget(options: { port: number; targetId?: string; correlationId?: string; expected?: VisibleSessionEvidence; background?: boolean }): Promise<VisibleSessionResult> {
  const correlationId = options.correlationId ?? randomUUID();
  const e: VisibleSessionEvidence = { host: hostname(), os: platform(), runtimeOwner: "console-mcp", interactiveUser: null, userId: null, guiSessionId: null, browserPid: null, processStartedAt: null, profile: null, display: null, windowId: null, cdpWindowId: null, endpoint: `http://127.0.0.1:${options.port}`, browserInstance: null, targetId: options.targetId ?? null, verifiedAt: null };
  const f: VisibleFacts = { cdp: false, target: false, process: false, gui: false, window: false, headless: false, sameUser: false, sameDisplay: false, sameWindow: false, locked: true, ambiguous: false };
  try {
    if (platform() === "linux" && options.port === 9224 && process.env.CONSOLE_MCP_DESKTOP_LOCAL !== "1") {
      const helper = fileURLToPath(new URL("../../ops/ubuntu/script/desktop-agent-client.py", import.meta.url));
      if (!options.targetId || !/^[A-Fa-f0-9]{32}$/.test(options.targetId)) return result(e, f, correlationId);
      const request = JSON.stringify({ version: 1, operation: options.background ? "verify-background" : "verify", requestId: correlationId, targetId: options.targetId });
      const reply = await new Promise<string>((resolve, reject) => {
        const child = execFile("/usr/bin/python3", [helper], { timeout: 16000, maxBuffer: 65536 }, (error, stdout) => error ? reject(error) : resolve(stdout));
        child.stdin?.end(request);
      });
      const verified = JSON.parse(reply) as VisibleSessionResult;
      if (!verified.evidence || verified.evidence.endpoint !== e.endpoint || verified.evidence.targetId !== options.targetId || verified.evidence.userId !== 1000) return result(e, f, correlationId);
      verified.correlationId = correlationId;
      if (verified.ok && options.expected && !sameVisibleRuntime(options.expected, verified.evidence)) return invalidate(verified, "TARGET_BELONGS_TO_ANOTHER_SESSION");
      return verified;
    }
    if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) return result(e, f, correlationId);
    const version = await json(e.endpoint, "/json/version"); f.cdp = true;
    const ws = new URL(version.webSocketDebuggerUrl); e.browserInstance = ws.pathname;
    if (options.expected && options.expected.browserInstance !== e.browserInstance) return { ...result(e, { ...f, target: false }, correlationId), reason: "BROWSER_TARGET_STALE" };
    const targets = await json(e.endpoint, "/json/list");
    const candidates = targets.filter((t: any) => t.type === "page" && (!options.targetId || t.id === options.targetId));
    if (candidates.length !== 1) return { ...result(e, f, correlationId), reason: candidates.length > 1 ? "AMBIGUOUS_VISIBLE_SESSIONS" : "BROWSER_TARGET_STALE" };
    e.targetId = candidates[0].id; f.target = true;
    const w = await visibleCdpCommand(ws.href, "Browser.getWindowForTarget", { targetId: e.targetId }); e.cdpWindowId = w.windowId;
    if (process.platform === "linux") await linuxEvidence(options.port, e, f, w.bounds, options.background === true);
    if (process.platform === "win32") await windowsEvidence(options.port, e, f, w.bounds);
    if (!options.background && classifyVisibleSession(f) === null) {
      const foreground = await visibleCdpCommand(candidates[0].webSocketDebuggerUrl, "Runtime.evaluate", {
        expression: "document.visibilityState === 'visible'", returnByValue: true,
      }, true);
      if (foreground.result?.value !== true) f.window = false;
      const authentication = await visibleCdpCommand(candidates[0].webSocketDebuggerUrl, "Runtime.evaluate", {
        expression: "Boolean(Array.from(document.querySelectorAll('input[type=password]')).some(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0)) || /^\\/(login|signin|sign-in)(\\/|$)/i.test(location.pathname)", returnByValue: true,
      });
      if (authentication.exceptionDetails || typeof authentication.result?.value !== "boolean") f.window = false;
      else f.authenticationRequired = authentication.result.value;
    }
    // Wayland remains explicitly unknown without compositor window evidence.
    // A remote Windows localhost route is never inferred from a Linux endpoint.
  } catch { f.window = false; f.sameWindow = false; /* never turn incomplete verification into readiness */ }
  const base = result(e, f, correlationId);
  if (options.background && !base.ok) {
    base.reason = `${base.reason}:process=${f.process},gui=${f.gui},sameUser=${f.sameUser},sameDisplay=${f.sameDisplay},locked=${f.locked},window=${f.window}`;
  }
  const verdict = options.background && base.ok ? { ...base, status: "BACKGROUND_TARGET_BOUND", states: base.states.filter(s => s !== "VISIBLE_WINDOW_VERIFIED" && s !== "USER_INTERACTION_READY"), visibility_verified: false, user_interaction_ready: false } : base;
  if (verdict.ok && (!e.profile || !e.processStartedAt || !e.guiSessionId)) return invalidate(verdict, "VISIBILITY_UNKNOWN");
  if (verdict.ok && options.expected && !sameVisibleRuntime(options.expected, e)) return invalidate(verdict, "TARGET_BELONGS_TO_ANOTHER_SESSION");
  return verdict;
}
export async function selectVisibleTarget(ports: number[], targetId?: string, correlationId?: string, background = false): Promise<VisibleSessionResult> {
  const probes: VisibleSessionResult[] = [];
  for (const port of [...new Set(ports)]) {
    let ids = targetId ? [targetId] : [];
    if (!targetId) { try { ids = (await json(`http://127.0.0.1:${port}`, "/json/list")).filter((t: any) => t.type === "page").map((t: any) => t.id); } catch { /* down */ } }
    if (!ids.length) probes.push(await inspectVisibleTarget({ port, targetId, correlationId, background }));
    for (const id of ids) probes.push(await inspectVisibleTarget({ port, targetId: id, correlationId, background }));
  }
  const fallback = probes.find(p => p.states.includes("CDP_CONNECTED")) ?? await inspectVisibleTarget({ port: ports[0], targetId, correlationId });
  return resolveVisibleCandidates(probes, fallback, targetId);
}

// A scan is a sequence of native observations, not an atomic desktop snapshot.
export function resolveVisibleCandidates(probes: VisibleSessionResult[], fallback: VisibleSessionResult, targetId?: string): VisibleSessionResult {
  const eligible = probes.filter(p => p.ok);
  if (eligible.length === 1) return eligible[0];
  const first = eligible[0];
  if (!targetId && first?.evidence.windowId && eligible.every(candidate =>
      candidate.evidence.windowId === first.evidence.windowId &&
      candidate.evidence.cdpWindowId === first.evidence.cdpWindowId &&
      sameVisibleRuntime(candidate.evidence, first.evidence))) return first;
  if (eligible.length > 1) {
    // Linux proofs require _NET_ACTIVE_WINDOW. Different foreground windows in
    // one runtime therefore came from changing snapshots, not simultaneous sessions.
    const changed = !targetId && first.evidence.os === "linux" &&
      eligible.every(candidate => sameVisibleRuntime(candidate.evidence, first.evidence)) &&
      new Set(eligible.map(candidate => candidate.evidence.windowId)).size > 1;
    return { ...invalidate(fallback, changed ? "VISIBLE_DISCOVERY_CHANGED" : "AMBIGUOUS_VISIBLE_SESSIONS"),
      resolution_candidates: eligible.map(({ reason, evidence }) => ({ reason, evidence })) };
  }
  return fallback;
}
