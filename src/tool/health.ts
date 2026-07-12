import os from "node:os";
import { spawnSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import type { ConsumerName } from "../engine/canonical-tool-registry.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

export type ConsoleRuntimeInfo = {
  buildFingerprint: string;
  canonicalRegistryFingerprint: string;
  consumers: Record<ConsumerName, { toolCount: number; schemaFingerprint: string }>;
};

export function registerHealthTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig, runtimeInfo?: ConsoleRuntimeInfo): void {
  server.registerTool(
    "console.read_.system.console.health",
    {
      description: "Return process health and runtime environment metadata.",
      inputSchema: z.object({}).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async () => textResult({
      ok: true,
      pid: process.pid,
      process: { pid: process.pid, cwd: process.cwd(), uptime_seconds: Math.floor(process.uptime()) },
      os: { platform: os.platform(), release: os.release(), arch: os.arch() },
      node: process.version,
      powershell: detectPowerShell(),
      policy_loaded: policy.loaded,
      ...(runtimeInfo ? {
        buildFingerprint: runtimeInfo.buildFingerprint,
        canonicalRegistryFingerprint: runtimeInfo.canonicalRegistryFingerprint,
        consumers: runtimeInfo.consumers,
      } : {}),
    })
  );
}

function detectPowerShell(): { available: boolean; command: string | null; version: string | null } {
  for (const command of ["pwsh", "powershell"]) {
    const result = spawnSync(command, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });

    if (!result.error && result.status === 0) {
      return {
        available: true,
        command,
        version: String(result.stdout ?? "").trim() || null,
      };
    }
  }

  return {
    available: false,
    command: null,
    version: null,
  };
}

