/** Native GNOME/X11 focus for an exact authenticated visible Edge target. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectVisibleTarget, visibleCdpCommand } from "../service/visible-browser-session.js";
const run = promisify(execFile);
const id = process.argv[2];
if (!/^[a-f0-9]{32}$/i.test(id ?? "") || process.getuid?.() !== 1000 || process.env.CONSOLE_MCP_DESKTOP_LOCAL !== "1") process.exit(64);
const deny = (reason: string) => ({ ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", reason, visibility_verified: false, user_interaction_ready: false, mutation_attempted: false });
const cmd = async (name: string, args: string[]) => (await run(name, args, { timeout: 2500, maxBuffer: 65536 })).stdout;
try {
  const proof = await inspectVisibleTarget({ port: 9224, targetId: id, background: true });
  if (!proof.ok || proof.evidence.userId !== 1000 || proof.evidence.profile !== "/home/alex/.config/console-mcp-edge-visible" || proof.evidence.display !== process.env.DISPLAY || !proof.evidence.browserPid) {
    console.log(JSON.stringify(deny(proof.reason ?? "UNVERIFIED_BROWSER"))); process.exit(0);
  }
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- Fixed loopback CDP endpoint; no user-controlled URL or remote transport.
  const version = await (await fetch("http://127.0.0.1:9224/json/version", { signal: AbortSignal.timeout(2000) })).json() as {webSocketDebuggerUrl: string};
  if (new URL(version.webSocketDebuggerUrl).pathname !== proof.evidence.browserInstance) throw new Error("BROWSER_INSTANCE_CHANGED");
  const root = await cmd("xprop", ["-root", "_NET_CLIENT_LIST"]);
  const ids = root.match(/0x[0-9a-f]+/gi) ?? [];
  const windows: string[] = [];
  for (const window of ids) {
    const props = await cmd("xprop", ["-id", window, "_NET_WM_PID", "_NET_WM_STATE"]);
    if (Number(props.match(/_NET_WM_PID.*= (\d+)/)?.[1]) !== proof.evidence.browserPid || /_NET_WM_STATE_HIDDEN/.test(props)) continue;
    if (/Map State: IsViewable/.test(await cmd("xwininfo", ["-id", window]))) windows.push(window);
  }
  if (windows.length !== 1) { console.log(JSON.stringify(deny("AMBIGUOUS_NATIVE_WINDOWS"))); process.exit(0); }
  await cmd("/usr/bin/python3", ["/home/alex/smartresponse/mcp/console-mcp/ops/ubuntu/script/native-window-activate.py", windows[0]]);
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- Fixed loopback CDP endpoint; no user-controlled URL or remote transport.
  const targets = await (await fetch("http://127.0.0.1:9224/json/list", { signal: AbortSignal.timeout(2000) })).json() as Array<{id:string;webSocketDebuggerUrl?:string}>;
  const target = targets.find((t: {id: string}) => t.id === id);
  if (!target?.webSocketDebuggerUrl) throw new Error("TARGET_STALE");
  await visibleCdpCommand(target.webSocketDebuggerUrl, "Page.bringToFront");
  const verified = await inspectVisibleTarget({ port: 9224, targetId: id, expected: proof.evidence });
  console.log(JSON.stringify(verified));
} catch { console.log(JSON.stringify(deny("NATIVE_FOCUS_UNVERIFIED"))); }
