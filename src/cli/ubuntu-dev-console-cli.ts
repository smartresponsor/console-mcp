import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectAuthStatus, inspectComposerPreflight, inventoryChatGptTargets } from "../service/browser-session-executor.js";
import { readRuntimeCapacity } from "../service/runtime-capacity.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const command = process.argv[2];
const supported = ["browser-status", "browser-ensure-visible", "chatgpt-page-status", "chatgpt-session-status", "stack-preflight"];
if (process.platform !== "linux" || !supported.includes(command ?? "")) throw new Error("Unsupported Linux diagnostic command");
const active = (unit: string): boolean => {
  try { return execFileSync("systemctl", ["is-active", unit], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "active"; }
  catch { return false; }
};
try {
  const version = await (await fetch("http://127.0.0.1:9223/json/version", { signal: AbortSignal.timeout(3000) })).json() as Record<string, string>;
  const edge = String(version["User-Agent"] ?? version.Browser).includes("Edg/");
  const listeners = execFileSync("ss", ["-H", "-ltn", "sport = :9223"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const loopback = listeners.length > 0 && listeners.every((line) => line.split(/\s+/)[3] === "127.0.0.1:9223");
  const browserService = active("console-mcp-browser.service");
  const browser = { ok: edge && loopback && browserService, owner: "Microsoft Edge", cdp: "127.0.0.1:9223", loopback_only: loopback, service_active: browserService, starts_browser: false };
  const inventory = await inventoryChatGptTargets({ ports: [9223], timeoutMs: 3000 });
  const pages = [...new Map([...(inventory.chat_targets as Record<string, unknown>[] ?? []), ...(inventory.root_targets as Record<string, unknown>[] ?? [])].map(page => [page.id, page])).values()];
  const targetId = pages.find(page => typeof page.id === "string")?.id as string | undefined;
  const preflight = targetId ? await inspectComposerPreflight({ ports: [9223], targetId, timeoutMs: 3000 }) : null;
  const auth = targetId ? await inspectAuthStatus({ ports: [9223], targetId, timeoutMs: 3000 }) : null;
  const authState = preflight?.auth_state as Record<string, unknown> | undefined;
  const composer = preflight?.composer as Record<string, unknown> | undefined;
  const session = { authenticated: authState?.authenticated === true, auth_status: auth?.status ?? null, composer_ready: preflight?.ok === true, composer_empty: composer?.textLength === 0, chatgpt_target_count: pages.length };
  let capacity: Record<string, unknown> | null = null;
  if (command === "stack-preflight") {
    const pid = execFileSync("systemctl", ["show", "console-mcp.service", "-p", "MainPID", "--value"], { encoding: "utf8" }).trim();
    if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("Console service is not running");
    capacity = readRuntimeCapacity(`/proc/${pid}/root${root}`);
  }
  const consoleActive = active("console-mcp.service");
  const browsingActive = active("browser-mcp-worker.service");
  const watchdogActive = active("console-mcp-watchdog.timer");
  const ok = browser.ok && (command.startsWith("chatgpt-") ? session.authenticated && session.composer_ready : true)
    && (command === "stack-preflight" ? consoleActive && browsingActive && watchdogActive && capacity?.decision === "ADMIT" : true);
  console.log(JSON.stringify({ ok, status: ok ? "READY" : "NOT_READY", command, browser, session, console_active: consoleActive, browsing_active: browsingActive, watchdog_active: watchdogActive, capacity: capacity?.decision ?? null, recovery_owner: "systemd", browser_restarted: false }));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, status: "LINUX_DIAGNOSTIC_UNAVAILABLE", command, error: error instanceof Error ? error.message : String(error), starts_browser: false }));
  process.exitCode = 1;
}
