import os from "node:os";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import type { ConsumerName } from "../engine/canonical-tool-registry.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const execFileAsync = promisify(execFile);
const availableRefreshIntervalMs = 5 * 60 * 1000;
const unavailableRefreshIntervalMs = 30 * 1000;

export type ConsoleRuntimeInfo = {
  buildFingerprint: string;
  canonicalRegistryFingerprint: string;
  consumers: Record<ConsumerName, { toolCount: number; schemaFingerprint: string }>;
};

type PowerShellCapability = {
  available: boolean;
  command: string | null;
  version: string | null;
  detection: "static" | "async-refresh" | "unavailable";
  refreshed_at: string | null;
};

const powershellCapability = createPowerShellCapabilityCache();

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
      powershell: powershellCapability.get(),
      policy_loaded: policy.loaded,
      ...(runtimeInfo ? {
        buildFingerprint: runtimeInfo.buildFingerprint,
        canonicalRegistryFingerprint: runtimeInfo.canonicalRegistryFingerprint,
        consumers: runtimeInfo.consumers,
      } : {}),
    })
  );
}

function createPowerShellCapabilityCache(): { get: () => PowerShellCapability } {
  let cached = detectPowerShellStatically();
  let lastRefreshStartedAt = 0;
  let refreshInFlight: Promise<void> | null = null;

  const refreshIfNeeded = (): void => {
    if (refreshInFlight) return;
    const now = Date.now();
    const refreshIntervalMs = cached.available ? availableRefreshIntervalMs : unavailableRefreshIntervalMs;
    if (lastRefreshStartedAt > 0 && now - lastRefreshStartedAt < refreshIntervalMs) return;

    lastRefreshStartedAt = now;
    refreshInFlight = refreshPowerShellCapability(cached.command).then((refreshed) => {
      cached = refreshed;
    }).catch(() => {
      cached = {
        ...cached,
        detection: cached.available ? "static" : "unavailable",
        refreshed_at: new Date().toISOString(),
      };
    }).finally(() => {
      refreshInFlight = null;
    });
  };

  refreshIfNeeded();

  return {
    get: () => {
      refreshIfNeeded();
      return cached;
    },
  };
}

function detectPowerShellStatically(): PowerShellCapability {
  for (const command of ["pwsh", "powershell"]) {
    const executable = findExecutableOnPath(command);
    if (executable) {
      return {
        available: true,
        command,
        version: null,
        detection: "static",
        refreshed_at: null,
      };
    }
  }

  return {
    available: false,
    command: null,
    version: null,
    detection: "unavailable",
    refreshed_at: null,
  };
}

async function refreshPowerShellCapability(preferredCommand: string | null): Promise<PowerShellCapability> {
  const commands = [...new Set([preferredCommand, "pwsh", "powershell"].filter((item): item is string => Boolean(item)))];
  for (const command of commands) {
    try {
      const result = await execFileAsync(command, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      });

      return {
        available: true,
        command,
        version: String(result.stdout ?? "").trim() || null,
        detection: "async-refresh",
        refreshed_at: new Date().toISOString(),
      };
    } catch {
      // Try the next static candidate; health itself never waits for this refresh.
    }
  }

  return {
    available: false,
    command: null,
    version: null,
    detection: "unavailable",
    refreshed_at: new Date().toISOString(),
  };
}

function findExecutableOnPath(command: string): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? process.env.path ?? "";
  const pathExt = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExtension = Boolean(path.extname(command));
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidates = hasExtension
      ? [path.join(directory, command)]
      : pathExt.map((extension) => path.join(directory, `${command}${extension.toLowerCase()}`));
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

