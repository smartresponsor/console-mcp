import { resolveMcpSiblingRepository } from "../service/mcp-sibling-repository.js";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { webOutcomePolicySummary } from "../Consumer/Web/WebOutcomePolicy.js";
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

const defaultWebBrowserPorts = [9222, 9223] as const;

const webBrowserStatusSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([...defaultWebBrowserPorts]),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const webBrowserInventorySchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([...defaultWebBrowserPorts]),
  includeAllTargets: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const webExecutionCorrelationSchema = z.object({
  taskId: z.string().min(1).max(200).optional(),
  runId: z.string().min(1).max(200).optional(),
  invocationId: z.string().min(1).max(200).optional(),
}).strict();

const webBrowserOpenSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([...defaultWebBrowserPorts]),
  url: z.string().min(1).max(2000),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
  confirmOpen: z.boolean().default(false),
  correlation: webExecutionCorrelationSchema.optional(),
}).strict();

const webBrowserToolNames = [
  "read_.web.browser.status",
  "read_.web.browser.inventory",
  "read_.web.capability.contract",
  "write.web.browser.open",
] as const;

export function registerWebBrowserBridgeTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  assertConsoleToolCatalogContains(webBrowserToolNames);

  server.registerTool("read_.web.browser.status", {
    description: "Read-only Network capability status over the Console-owned supervised browser runtime. It never starts a separate Network browser worker.",
    inputSchema: webBrowserStatusSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await inspectWebBrowserStatus(input)));

  server.registerTool("read_.web.browser.inventory", {
    description: "Read-only inventory of page targets available to Network capability through Console-owned DevTools ports.",
    inputSchema: webBrowserInventorySchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await inspectWebBrowserInventory(input)));

  server.registerTool("write.web.browser.open", {
    description: "Open a URL through the Console-owned supervised browser runtime. This tool does not launch or own a separate Browser MCP browser.",
    inputSchema: webBrowserOpenSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await openWebBrowserPage(input)));

  server.registerTool("read_.web.capability.contract", {
    description: "Read the Network-owned capability contract consumed by the Console MCP Network bridge.",
    inputSchema: z.object({}).strict(),
    ...buildConsoleToolRegistration(authConfig),
  }, async () => textResult(await inspectWebCapabilityContract()));
}

async function inspectWebCapabilityContract(): Promise<Record<string, unknown>> {
  const contractPath = resolveWebCapabilityContractPath();
  if (!existsSync(contractPath)) {
    return {
      ok: false,
      status: "NETWORK_CAPABILITY_CONTRACT_MISSING",
      contract_path: contractPath,
      recommended_action: "Set BROWSER_MCP_CAPABILITY_CONTRACT_PATH or keep Browsing as a sibling of console-mcp inside the canonical mcp workspace.",
    };
  }

  try {
    const moduleUrl = pathToFileURL(contractPath).href;
    const imported = await import(`${moduleUrl}?cacheBust=${Date.now()}`) as {
      networkCapabilityContract?: unknown;
      networkCapabilityAliases?: unknown;
    };
    const contract = imported.networkCapabilityContract;
    if (!isRecord(contract)) {
      return {
        ok: false,
        status: "NETWORK_CAPABILITY_CONTRACT_INVALID",
        contract_path: contractPath,
        reason: "networkCapabilityContract export is missing or is not an object.",
      };
    }

    const tools = Array.isArray(contract.tools) ? contract.tools.filter(isRecord) : [];
    const aliases = isRecord(imported.networkCapabilityAliases) ? imported.networkCapabilityAliases : {};
    const readToolCount = tools.filter((tool) => tool.risk === "read").length;
    const writeToolCount = tools.filter((tool) => tool.risk === "write").length;
    const publicToolCount = tools.filter((tool) => tool.visibility !== "internal").length;
    const internalToolCount = tools.length - publicToolCount;
    const approvalToolCount = tools.filter((tool) => tool.requiresExplicitApproval === true).length;
    const riskClasses = [...new Set(tools
      .map((tool) => typeof tool.riskClass === "string" ? tool.riskClass : null)
      .filter((value): value is string => value !== null))].sort();
    const boundary = isRecord(contract.boundary) ? contract.boundary : {};
    const worker = isRecord(contract.worker) ? contract.worker : {};
    const synergyReady = contract.schemaVersion === 2
      && boundary.browserOwner === "console-mcp"
      && boundary.executionOwner === "console-mcp"
      && boundary.orchestrationOwner === "console-mcp"
      && boundary.capabilityOwner === "browser-mcp"
      && boundary.domainStateOwner === "browser-mcp"
      && boundary.competingBrowserLaunchAllowed === false
      && boundary.genericAsyncLifecycleOwnedByNetwork === false
      && boundary.genericExecutionLeaseOwnedByNetwork === false
      && worker.browserAttachment === "console-owned-cdp";

    return {
      ok: true,
      status: synergyReady ? "NETWORK_CAPABILITY_CONTRACT_READY" : "NETWORK_CAPABILITY_CONTRACT_DEGRADED",
      mode: "console-owned-browser-runtime",
      contract_path: contractPath,
      schema_version: contract.schemaVersion ?? null,
      contract_version: contract.contractVersion ?? null,
      owner: contract.owner ?? null,
      boundary: contract.boundary ?? null,
      worker: contract.worker ?? null,
      synergy: {
        ready: synergyReady,
        expected_schema_version: 2,
        browser_runtime_owner: boundary.browserOwner ?? null,
        execution_owner: boundary.executionOwner ?? null,
        orchestration_owner: boundary.orchestrationOwner ?? null,
        capability_owner: boundary.capabilityOwner ?? null,
        domain_state_owner: boundary.domainStateOwner ?? null,
        browser_attachment: worker.browserAttachment ?? null,
        competing_browser_launch_allowed: boundary.competingBrowserLaunchAllowed ?? null,
        network_owns_generic_async_lifecycle: boundary.genericAsyncLifecycleOwnedByNetwork ?? null,
        network_owns_generic_execution_lease: boundary.genericExecutionLeaseOwnedByNetwork ?? null,
      },
      tool_count: tools.length,
      public_tool_count: publicToolCount,
      internal_tool_count: internalToolCount,
      read_tool_count: readToolCount,
      write_tool_count: writeToolCount,
      approval_tool_count: approvalToolCount,
      alias_count: Object.keys(aliases).length,
      aliases,
      risk_classes: riskClasses,
      outcome_policy: webOutcomePolicySummary,
      tools: tools.map((tool) => ({
        name: typeof tool.name === "string" ? tool.name : null,
        route: typeof tool.route === "string" ? tool.route : null,
        risk: typeof tool.risk === "string" ? tool.risk : null,
        risk_class: typeof tool.riskClass === "string" ? tool.riskClass : null,
        visibility: typeof tool.visibility === "string" ? tool.visibility : null,
        input_schema_id: typeof tool.inputSchemaId === "string" ? tool.inputSchemaId : null,
        result_schema_id: typeof tool.resultSchemaId === "string" ? tool.resultSchemaId : null,
        approval_policy: typeof tool.approvalPolicy === "string" ? tool.approvalPolicy : null,
        requires_explicit_approval: tool.requiresExplicitApproval === true,
        binding: typeof tool.binding === "string" ? tool.binding : null,
        replay_policy: typeof tool.replayPolicy === "string" ? tool.replayPolicy : null,
        timeout_class: typeof tool.timeoutClass === "string" ? tool.timeoutClass : null,
        artifact_behavior: typeof tool.artifactBehavior === "string" ? tool.artifactBehavior : null,
        execution_correlation: typeof tool.executionCorrelation === "string" ? tool.executionCorrelation : null,
        postcondition: typeof tool.postcondition === "string" ? tool.postcondition : null,
        legacy_connector_surface: tool.legacyConnectorSurface === true,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      status: "NETWORK_CAPABILITY_CONTRACT_IMPORT_FAILED",
      contract_path: contractPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function inspectWebBrowserStatus(input: z.infer<typeof webBrowserStatusSchema>): Promise<Record<string, unknown>> {
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

async function inspectWebBrowserInventory(input: z.infer<typeof webBrowserInventorySchema>): Promise<Record<string, unknown>> {
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


async function openWebBrowserPage(input: z.infer<typeof webBrowserOpenSchema>): Promise<Record<string, unknown>> {
  const correlation = normalizeWebExecutionCorrelation(input.correlation);
  if (input.confirmOpen !== true) {
    return {
      ok: false,
      status: "NETWORK_BROWSER_OPEN_CONFIRMATION_REQUIRED",
      mode: "console-owned-browser-runtime",
      requested_url: sanitizeUrlForOutput(input.url),
      correlation,
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
          correlation,
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
    correlation,
    attempts,
  };
}

function normalizeWebExecutionCorrelation(input: z.infer<typeof webExecutionCorrelationSchema> | undefined): Record<string, unknown> | null {
  if (!input) return null;
  return {
    owner: "console-mcp",
    task_id: input.taskId ?? null,
    run_id: input.runId ?? null,
    invocation_id: input.invocationId ?? null,
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

function resolveWebCapabilityContractPath(): string {
  const configured = process.env.BROWSER_MCP_CAPABILITY_CONTRACT_PATH;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return resolve(configured.trim());
  }

  return resolve(resolveMcpSiblingRepository("browsing"), "mcp-server", "src", "capability-contract.js");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

