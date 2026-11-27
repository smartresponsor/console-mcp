import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const markerPath = "/var/lib/console-mcp-deployment-quiesce";
const healthName = "read_.system.console.health";

export type IngressMarker = { state: "open" } | { state: "quiescing"; generation: string } | { state: "unavailable" };

// Persistent root-owned marker survives a host reboot during cutover.
// No request input, env override, or tool invocation can open a closed gate.
function readMarker(): IngressMarker {
  let fd: number;
  try {
    fd = fs.openSync(markerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "open" } : { state: "unavailable" };
  }
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n ||
        (before.mode & 0o022n) !== 0n || before.size !== 33n) return { state: "unavailable" };
    const raw = Buffer.alloc(34);
    const count = fs.readSync(fd, raw, 0, raw.length, 0);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(markerPath, { bigint: true });
    const same = (a: typeof before, b: typeof before) =>
      a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode &&
      a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
    if (!same(before, after) || !same(before, current) || count !== 33) return { state: "unavailable" };
    return decodeRuntimeIngressMarker(raw.subarray(0, count));
  } catch {
    return { state: "unavailable" };
  } finally {
    fs.closeSync(fd);
  }
}

export function decodeRuntimeIngressMarker(raw: Buffer): IngressMarker {
  const value = raw.toString("latin1");
  return raw.length === 33 && /^[a-f0-9]{32}\n$/.test(value)
    ? { state: "quiescing", generation: value.slice(0, -1) } : { state: "unavailable" };
}

export function createRuntimeToolIngress(marker: () => IngressMarker, enabled: boolean) {
  let active = 0;
  const read = (): IngressMarker => {
    try { return enabled ? marker() : { state: "open" }; }
    catch { return { state: "unavailable" }; }
  };
  function snapshot() {
    const state = read();
    return {
      protocol: 1,
      enabled,
      state: state.state,
      generation: state.state === "quiescing" ? state.generation : null,
      activeHandlers: active,
      drained: enabled && state.state === "quiescing" && active === 0,
    };
  }
  async function invoke(name: string, handler: (...args: unknown[]) => unknown, args: unknown[]): Promise<unknown> {
    // This exact read-only diagnostic is the only exemption. It reports
    // non-health handlers, not detached processes or external CDP clients.
    if (name === healthName) return await handler(...args);
    const state = read();
    if (state.state !== "open") {
      const result = { ok: false, status: "RUNTIME_INGRESS_QUIESCED", reason: state.state,
        mutation_attempted: false, automatic_retry_allowed: false };
      return { isError: true, structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    // No await between the marker check and admission/count increment.
    active++;
    try { return await handler(...args); }
    finally { active--; }
  }
  function wrap(server: McpServer): McpServer {
    return new Proxy(server, {
      get(target, prop, receiver) {
        if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
        return (name: string, config: unknown, handler: unknown) => {
          if (typeof handler !== "function") throw new Error("Invalid MCP handler");
          const wrapped = (...args: unknown[]) => invoke(name, handler as (...values: unknown[]) => unknown, args);
          return (target as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool(name, config, wrapped);
        };
      },
    }) as McpServer;
  }
  return { snapshot, invoke, wrap };
}

export const runtimeToolIngress = createRuntimeToolIngress(readMarker,
  process.platform === "linux" && process.env.CONSOLE_MCP_MANAGED_RUNTIME?.trim() === "systemd");
