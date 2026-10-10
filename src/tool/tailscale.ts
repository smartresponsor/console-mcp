import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

type JsonObject = Record<string, unknown>;

export function registerTailscaleTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  const readRegistration = buildConsoleToolRegistration(authConfig);
  const writeRegistration = buildConsoleMutationToolRegistration(authConfig);

  server.registerTool(
    "read_.tailscale.status.inspect",
    {
      description: "Inspect local Tailscale client identity and peer connectivity without changing VPN state or exposing reusable authentication material.",
      inputSchema: z.object({}).strict(),
      ...readRegistration,
    },
    async () => textResult(await tailscaleStatus()),
  );

  server.registerTool(
    "read_.tailscale.settings.inspect",
    {
      description: "Inspect an allowlisted subset of local Tailscale preferences. Auth keys, tokens, credentials, and arbitrary preference fields are never returned.",
      inputSchema: z.object({}).strict(),
      ...readRegistration,
    },
    async () => textResult(await tailscalePreferences()),
  );

  server.registerTool(
    "write.tailscale.settings.set",
    {
      description: "Set only allowlisted Tailscale client preferences. Arbitrary CLI flags, auth keys, login, logout, down, and remote administration are not available.",
      inputSchema: z.object({
        acceptDns: z.boolean().optional(),
        acceptRoutes: z.boolean().optional(),
        shieldsUp: z.boolean().optional(),
        hostname: z.string().min(1).max(63).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/).optional(),
        confirmSet: z.boolean().default(false),
      }).strict().refine(
        (value) => value.acceptDns !== undefined || value.acceptRoutes !== undefined || value.shieldsUp !== undefined || value.hostname !== undefined,
        { message: "At least one Tailscale setting must be supplied." },
      ),
      ...writeRegistration,
    },
    async (input) => textResult(await setTailscalePreferences(input)),
  );
}

async function tailscaleStatus(): Promise<Record<string, unknown>> {
  const result = await runSupervisedCommand(process.cwd(), "tailscale", ["status", "--json"], 30000, 2 * 1024 * 1024);
  if (!result.ok) return { ok: false, status: "TAILSCALE_STATUS_UNAVAILABLE", exitCode: result.exitCode, stderr: result.stderr.trim() };
  const parsed = parseJson(result.stdout);
  if (!parsed) return { ok: false, status: "TAILSCALE_STATUS_INVALID_JSON", exitCode: result.exitCode };
  const self = objectValue(parsed.Self);
  const peers = objectValue(parsed.Peer);
  return {
    ok: true,
    status: "TAILSCALE_STATUS_INSPECTED",
    backendState: stringValue(parsed.BackendState),
    currentTailnet: stringValue(objectValue(parsed.CurrentTailnet)?.Name),
    self: safePeer(self),
    peers: peers ? Object.values(peers).map((peer) => safePeer(objectValue(peer))).filter(Boolean) : [],
  };
}

async function tailscalePreferences(): Promise<Record<string, unknown>> {
  const result = await runSupervisedCommand(process.cwd(), "tailscale", ["debug", "prefs"], 30000, 2 * 1024 * 1024);
  if (!result.ok) return { ok: false, status: "TAILSCALE_SETTINGS_UNAVAILABLE", exitCode: result.exitCode, stderr: result.stderr.trim() };
  const parsed = parseJson(result.stdout);
  if (!parsed) return { ok: false, status: "TAILSCALE_SETTINGS_INVALID_JSON", exitCode: result.exitCode };
  return {
    ok: true,
    status: "TAILSCALE_SETTINGS_INSPECTED",
    settings: {
      hostname: stringValue(parsed.Hostname),
      acceptDns: booleanValue(parsed.CorpDNS),
      acceptRoutes: booleanValue(parsed.RouteAll),
      shieldsUp: booleanValue(parsed.ShieldsUp),
      wantRunning: booleanValue(parsed.WantRunning),
    },
    secretsReturned: false,
  };
}

async function setTailscalePreferences(input: { acceptDns?: boolean; acceptRoutes?: boolean; shieldsUp?: boolean; hostname?: string; confirmSet?: boolean }): Promise<Record<string, unknown>> {
  const args = ["set"];
  if (input.acceptDns !== undefined) args.push(`--accept-dns=${input.acceptDns}`);
  if (input.acceptRoutes !== undefined) args.push(`--accept-routes=${input.acceptRoutes}`);
  if (input.shieldsUp !== undefined) args.push(`--shields-up=${input.shieldsUp}`);
  if (input.hostname !== undefined) args.push(`--hostname=${input.hostname}`);

  if (!input.confirmSet) {
    return {
      ok: false,
      status: "CONFIRM_TAILSCALE_SETTINGS_SET_REQUIRED",
      command: ["tailscale", ...args].join(" "),
      requires: { ...input, confirmSet: true },
      policy: { arbitraryFlags: false, authKeys: false, login: false, logout: false, down: false, remoteAdmin: false },
    };
  }

  const result = await runSupervisedCommand(process.cwd(), "tailscale", args, 30000, 2 * 1024 * 1024);
  return {
    ok: result.ok,
    status: result.ok ? "TAILSCALE_SETTINGS_SET" : "TAILSCALE_SETTINGS_SET_FAILED",
    command: ["tailscale", ...args].join(" "),
    exitCode: result.exitCode,
    stderr: result.stderr.trim(),
    policy: { arbitraryFlags: false, authKeys: false, login: false, logout: false, down: false, remoteAdmin: false },
  };
}

function parseJson(raw: string): JsonObject | null {
  try {
    const value = JSON.parse(raw);
    return objectValue(value);
  } catch {
    return null;
  }
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function safePeer(peer: JsonObject | null): Record<string, unknown> | null {
  if (!peer) return null;
  return {
    id: stringValue(peer.ID),
    hostName: stringValue(peer.HostName),
    dnsName: stringValue(peer.DNSName),
    tailscaleIPs: Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.filter((value): value is string => typeof value === "string") : [],
    online: booleanValue(peer.Online),
    active: booleanValue(peer.Active),
  };
}
