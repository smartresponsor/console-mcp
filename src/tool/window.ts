import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";
import { assertConsoleToolCatalogContains } from "./catalog.js";

const windowId = z.string().regex(/^0x[0-9a-fA-F]{1,16}$/);
const empty = z.object({}).strict();
const specific = z.object({ windowId }).strict();
const mutation = z.object({ windowId, approved: z.literal(true) }).strict();
const names = ["read_.window.inventory", "read_.window.inspect", "read_.window.inspect.focus", "write.window.activate"] as const;
type Operation = "window-inventory" | "window-inspect" | "window-inspect-focus" | "window-activate";

async function requestDesktop(operation: Operation, selected?: string): Promise<Record<string, unknown>> {
  if (process.platform === "win32") {
    // Activation remains Linux-only until Windows activation has its own verified contract.
    if (operation === "window-activate") return { ok: false, status: "WINDOW_ACTIVATION_UNSUPPORTED", visibility_verified: false };
    try {
      const script = fileURLToPath(new URL("../../tool/visible-browser-native-windows.ps1", import.meta.url));
      const stdout = await new Promise<string>((resolve, reject) => execFile("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-File", script, "-Operation", operation, ...(selected ? ["-WindowId", selected] : [])],
        { timeout: 16000, maxBuffer: 1024 * 1024 }, (error, output) => error ? reject(error) : resolve(output)));
      const reply = JSON.parse(stdout);
      if (!reply || typeof reply !== "object" || Array.isArray(reply) || typeof reply.ok !== "boolean") throw new Error("Invalid native reply");
      return { ...reply, visibility_verified: false, user_interaction_ready: false };
    } catch { return { ok: false, status: "WINDOW_AGENT_UNAVAILABLE", visibility_verified: false }; }
  }
  if (process.platform !== "linux") return { ok: false, status: "WINDOW_PLATFORM_UNSUPPORTED" };
  const body = { version: 1, operation, requestId: randomUUID(), ...(selected ? { windowId: selected } : {}) };
  const script = fileURLToPath(new URL("../../ops/ubuntu/script/desktop-agent-client.py", import.meta.url));
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile("/usr/bin/python3", [script], { timeout: 16000, maxBuffer: 65536 },
        (error, output) => error ? reject(error) : resolve(output));
      child.stdin?.end(JSON.stringify(body));
    });
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid reply");
    const reply = result as Record<string, unknown>;
    if (reply.requestId !== body.requestId) throw new Error("Mismatched request");
    delete reply.requestId;
    return reply;
  } catch {
    return { ok: false, status: "WINDOW_AGENT_UNAVAILABLE", visibility_verified: false };
  }
}

export function registerWindowTools(server: McpServer, auth: ConsoleAuthConfig): void {
  assertConsoleToolCatalogContains(names);
  server.registerTool("read_.window.inventory", {
    description: "List native GUI windows with hexadecimal OS window ID, process, geometry and visibility. Does not require a browser target to be visible.",
    inputSchema: empty, ...buildConsoleToolRegistration(auth),
  }, async () => textResult(await requestDesktop("window-inventory")));
  server.registerTool("read_.window.inspect", {
    description: "Inspect native OS window properties for an exact hexadecimal OS window ID.",
    inputSchema: specific, ...buildConsoleToolRegistration(auth),
  }, async ({ windowId }) => textResult(await requestDesktop("window-inspect", windowId)));
  server.registerTool("read_.window.inspect.focus", {
    description: "Inspect native foreground window and keyboard input focus as separate IDs.",
    inputSchema: empty, ...buildConsoleToolRegistration(auth),
  }, async () => textResult(await requestDesktop("window-inspect-focus")));
  server.registerTool("write.window.activate", {
    description: "Request activation of an exact visible native Window ID and verify the resulting active window. No mouse or keyboard injection.",
    inputSchema: mutation, ...buildConsoleMutationToolRegistration(auth),
  }, async ({ windowId }) => textResult(await requestDesktop("window-activate", windowId)));
}
