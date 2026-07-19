import { request } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";
import { assertConsoleToolCatalogContains } from "./catalog.js";

type BrowserDebugTarget = {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type NormalizedTarget = {
  id: string | null;
  type: string | null;
  title: string | null;
  url: string | null;
  port: number;
  has_web_socket_debugger_url: boolean;
};

const defaultNetworkBrowserPorts = [9222, 9223] as const;
const jobBoardHosts = new Set([
  "job-boards.greenhouse.io",
  "boards.greenhouse.io",
  "jobs.lever.co",
  "ashbyhq.com",
  "jobs.ashbyhq.com",
  "workable.com",
  "bamboohr.com",
  "smartrecruiters.com",
  "myworkdayjobs.com",
]);

const networkBrowserStatusSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([...defaultNetworkBrowserPorts]),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const networkBrowserInventorySchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([...defaultNetworkBrowserPorts]),
  includeAllTargets: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const networkBrowserOpenSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([...defaultNetworkBrowserPorts]),
  url: z.string().min(1).max(2000),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
  confirmOpen: z.boolean().default(false),
}).strict();

const networkBrowserToolNames = [
  "console.read_.network.browser.status",
  "console.read_.network.browser.inventory",
  "console.write.network.browser.open",
  "console.read_.network.surface.plan",
  "console.read_.network.browser.targets",
  "console.write.network.url.open",
  "console.write.network.job.open",
] as const;

export function registerNetworkBrowserBridgeTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  assertConsoleToolCatalogContains(networkBrowserToolNames);

  server.registerTool("console.read_.network.browser.status", {
    description: "Read-only Network capability status over the Console-owned supervised browser runtime. It never starts a separate Network browser worker.",
    inputSchema: networkBrowserStatusSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await inspectNetworkBrowserStatus(input)));

  server.registerTool("console.read_.network.browser.inventory", {
    description: "Read-only inventory of page targets available to Network capability through Console-owned DevTools ports.",
    inputSchema: networkBrowserInventorySchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await inspectNetworkBrowserInventory(input)));

  server.registerTool("console.write.network.browser.open", {
    description: "Open a URL through the Console-owned supervised browser runtime. This tool does not launch or own a separate Network MCP browser.",
    inputSchema: networkBrowserOpenSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await openNetworkBrowserPage(input)));

  server.registerTool("console.read_.network.surface.plan", {
    description: "Describe the one-connector Network surface exposed through Console MCP and the boundary with the legacy Network MCP connector.",
    inputSchema: z.object({}).strict(),
    ...buildConsoleToolRegistration(authConfig),
  }, async () => textResult(buildNetworkSurfacePlan()));

  server.registerTool("console.read_.network.browser.targets", {
    description: "List Network-capable browser page targets from the Console-owned supervised browser runtime.",
    inputSchema: networkBrowserInventorySchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await inspectNetworkBrowserInventory(input)));

  server.registerTool("console.write.network.url.open", {
    description: "Network facade: open a URL through the single Console MCP connector and Console-owned browser runtime.",
    inputSchema: networkBrowserOpenSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await openNetworkBrowserPage(input)));

  server.registerTool("console.write.network.job.open", {
    description: "Network facade: open a job URL through the single Console MCP connector and Console-owned browser runtime.",
    inputSchema: networkBrowserOpenSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await openNetworkBrowserJobPage(input)));
}

function buildNetworkSurfacePlan(): Record<string, unknown> {
  return {
    ok: true,
    status: "NETWORK_SURFACE_CONSOLE_CONNECTOR_READY",
    connector_model: "single-chatgpt-facing-console-mcp-connector",
    boundary: {
      schema_owner: "console-mcp",
      runtime_owner: "console-mcp",
      browser_owner: "console-mcp",
      capability_owner: "network",
      legacy_network_connector_required: false,
      launches_network_worker: false,
    },
    exposed_tools: [
      "console.read_.network.surface.plan",
      "console.read_.network.browser.status",
      "console.read_.network.browser.targets",
      "console.write.network.url.open",
      "console.write.network.job.open",
    ],
    legacy_tools_preserved: [
      "console.read_.network.browser.inventory",
      "console.write.network.browser.open",
    ],
    migration_note: "ChatGPT should refresh only the Console MCP connector schema. The standalone Network MCP connector can remain installed for compatibility, but it is no longer required for this Console-owned browser surface.",
  };
}

async function inspectNetworkBrowserStatus(input: z.infer<typeof networkBrowserStatusSchema>): Promise<Record<string, unknown>> {
  const ports = normalizePorts(input.ports);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const attempts = await Promise.all(ports.map((port) => inspectPort(port, timeoutMs)));
  const readyPorts = attempts.filter((attempt) => attempt.ok === true);
  const pageTargetCount = attempts.reduce((total, attempt) => total + attempt.page_target_count, 0);

  return {
    ok: readyPorts.length > 0,
    status: readyPorts.length > 0 ? "NETWORK_BROWSER_BRIDGE_READY" : "NETWORK_BROWSER_BRIDGE_DOWN",
    mode: "console-owned-browser-runtime",
    boundary: {
      runtime_owner: "console-mcp",
      capability_owner: "network",
      launches_browser: false,
      uses_devtools_ports: true,
    },
    ports,
    ready_port_count: readyPorts.length,
    page_target_count: pageTargetCount,
    attempts,
  };
}

async function inspectNetworkBrowserInventory(input: z.infer<typeof networkBrowserInventorySchema>): Promise<Record<string, unknown>> {
  const ports = normalizePorts(input.ports);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const attempts: Array<Record<string, unknown>> = [];
  const targets: NormalizedTarget[] = [];

  for (const port of ports) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const list = JSON.parse(raw) as BrowserDebugTarget[];
      const normalized = (Array.isArray(list) ? list : [])
        .map((target) => normalizeTarget(port, target))
        .filter((target): target is NormalizedTarget => target !== null);
      targets.push(...normalized);
      attempts.push({ port, ok: true, target_count: normalized.length });
    } catch (error) {
      attempts.push({ port, ok: false, target_count: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const pageTargets = targets.filter((target) => target.type === "page");
  const openableTargets = pageTargets.filter((target) => target.has_web_socket_debugger_url);

  return {
    ok: attempts.some((attempt) => attempt.ok === true),
    status: attempts.some((attempt) => attempt.ok === true) ? "NETWORK_BROWSER_INVENTORY_READY" : "NETWORK_BROWSER_BRIDGE_DOWN",
    mode: "console-owned-browser-runtime",
    ports,
    attempts,
    target_count: targets.length,
    page_target_count: pageTargets.length,
    openable_page_target_count: openableTargets.length,
    page_targets: pageTargets.map(compactTarget),
    targets: input.includeAllTargets ? targets.map(compactTarget) : undefined,
  };
}

async function openNetworkBrowserJobPage(input: z.infer<typeof networkBrowserOpenSchema>): Promise<Record<string, unknown>> {
  const targetUrl = normalizeNavigableUrl(input.url);
  if (!isJobBoardHost(targetUrl.hostname.toLowerCase())) {
    return {
      ok: false,
      status: "NETWORK_JOB_URL_UNSUPPORTED_HOST",
      mode: "console-owned-browser-runtime",
      requested_url: sanitizeUrlForOutput(targetUrl.href),
      supported_hosts: [...jobBoardHosts].sort(),
    };
  }

  const result = await openNetworkBrowserPage({ ...input, url: targetUrl.toString() });
  return {
    ...result,
    facade: "network-job-open",
    page_type: "job-board",
  };
}

async function openNetworkBrowserPage(input: z.infer<typeof networkBrowserOpenSchema>): Promise<Record<string, unknown>> {
  if (input.confirmOpen !== true) {
    return {
      ok: false,
      status: "NETWORK_BROWSER_OPEN_CONFIRMATION_REQUIRED",
      mode: "console-owned-browser-runtime",
      requested_url: sanitizeUrlForOutput(input.url),
      confirm_required: "Set confirmOpen=true after reviewing the target URL.",
    };
  }

  const targetUrl = normalizeNavigableUrl(input.url);
  const ports = normalizePorts(input.ports);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const attempts: Array<Record<string, unknown>> = [];

  for (const port of ports) {
    const path = `/json/new?${encodeURIComponent(targetUrl.href)}`;
    for (const method of ["PUT", "GET"] as const) {
      try {
        const raw = await devToolsTextRequest(port, path, method, timeoutMs);
        const target = normalizeTarget(port, JSON.parse(raw) as BrowserDebugTarget);
        return {
          ok: true,
          status: "NETWORK_BROWSER_OPENED_IN_CONSOLE_RUNTIME",
          mode: "console-owned-browser-runtime",
          port,
          method,
          requested_url: sanitizeUrlForOutput(targetUrl.href),
          target: target ? compactTarget(target) : null,
        };
      } catch (error) {
        attempts.push({ port, method, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return {
    ok: false,
    status: "NETWORK_BROWSER_OPEN_FAILED",
    mode: "console-owned-browser-runtime",
    requested_url: sanitizeUrlForOutput(targetUrl.href),
    attempts,
  };
}

async function inspectPort(port: number, timeoutMs: number): Promise<{ port: number; ok: boolean; page_target_count: number; error?: string }> {
  try {
    const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
    const list = JSON.parse(raw) as BrowserDebugTarget[];
    const pageTargetCount = (Array.isArray(list) ? list : []).filter((target) => target.type === "page").length;
    return { port, ok: true, page_target_count: pageTargetCount };
  } catch (error) {
    return { port, ok: false, page_target_count: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

function devToolsTextRequest(port: number, path: string, method: "GET" | "PUT", timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const statusCode = res.statusCode ?? 0;
        if (statusCode >= 200 && statusCode < 300) resolve(body);
        else reject(new Error(`DevTools HTTP ${statusCode}: ${body.slice(0, 300)}`));
      });
    });
    req.on("timeout", () => req.destroy(new Error(`DevTools request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

function normalizeTarget(port: number, target: BrowserDebugTarget): NormalizedTarget | null {
  if (typeof target !== "object" || target === null) return null;
  return {
    id: typeof target.id === "string" ? target.id : null,
    type: typeof target.type === "string" ? target.type : null,
    title: typeof target.title === "string" ? target.title : null,
    url: typeof target.url === "string" ? target.url : null,
    port,
    has_web_socket_debugger_url: typeof target.webSocketDebuggerUrl === "string" && target.webSocketDebuggerUrl.length > 0,
  };
}

function compactTarget(target: NormalizedTarget): Record<string, unknown> {
  return {
    id: target.id,
    type: target.type,
    title: target.title,
    url: target.url ? sanitizeUrlForOutput(target.url) : null,
    port: target.port,
    has_web_socket_debugger_url: target.has_web_socket_debugger_url,
  };
}

function normalizePorts(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value >= 1024 && value <= 65535))];
}

function normalizeTimeout(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 250), 10000);
}

function isJobBoardHost(host: string): boolean {
  return [...jobBoardHosts].some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
}

function normalizeNavigableUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be opened through the Network browser bridge.");
  }
  url.username = "";
  url.password = "";
  return url;
}

function sanitizeUrlForOutput(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/(token|secret|password|passwd|pwd|key|auth|session|csrf|xsrf|signature|sig|code|state)/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return raw.split("?")[0].slice(0, 500);
  }
}

