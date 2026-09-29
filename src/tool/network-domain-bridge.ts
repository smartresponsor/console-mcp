import { request } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMcpRequestContext } from "../Infrastructure/Diagnostics/RequestContext.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";
import { assertConsoleToolCatalogContains } from "./catalog.js";

type NetworkDomainDefinition = {
  canonicalName: string;
  consoleName: string;
  route: string;
  capabilityName: string;
  access: "read" | "write";
  description: string;
  inputSchema: z.ZodTypeAny;
  toPayload: (input: unknown) => unknown;
};

type NetworkDomainDefinitionsModule = {
  createNetworkCoreDomainToolDefinitions: () => readonly NetworkDomainDefinition[];
};

type LoadedNetworkDefinitions = {
  path: string;
  definitions: readonly NetworkDomainDefinition[];
  error: string | null;
};

const requireFromHere = createRequire(import.meta.url);

export const consoleNetworkDomainToolNames = [
  "read_.network.browser.targets",
  "write.network.browser.bind",
  "write.network.target.open",
  "write.network.job.open",
  "read_.network.chatgpt.snapshot",
  "read_.network.page.capture",
  "read_.network.page.wait",
  "read_.network.form.inspect",
  "write.network.page.click",
  "read_.network.form.extract",
  "write.network.form.proposal.preview",
  "write.network.form.fill",
  "write.network.form.upload",
  "write.network.form.review.snapshot",
  "write.network.form.submit",
] as const;

const correlationCapabilities = new Set([
  "network.click",
  "network.fill_after_approval",
  "network.upload_artifact",
  "network.submit_after_approval",
]);

export function registerNetworkDomainBridgeTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  assertConsoleToolCatalogContains(consoleNetworkDomainToolNames);

  const loaded = loadNetworkDomainDefinitions();
  const definitionsByConsoleName = new Map(loaded.definitions.map((definition) => [definition.consoleName, definition]));

  for (const consoleName of consoleNetworkDomainToolNames) {
    const definition = definitionsByConsoleName.get(consoleName);
    const access: "read" | "write" = consoleName.startsWith("read_.") ? "read" : "write";
    const registration = access === "write"
      ? buildConsoleMutationToolRegistration(authConfig)
      : buildConsoleToolRegistration(authConfig);

    if (!definition) {
      server.registerTool(consoleName, {
        description: "Network domain capability is unavailable because the canonical Network definitions could not be loaded.",
        inputSchema: z.object({}).passthrough(),
        ...registration,
      }, async () => textResult({
        ok: false,
        status: "NETWORK_DOMAIN_DEFINITIONS_UNAVAILABLE",
        definitions_path: loaded.path,
        error: loaded.error,
        capability: consoleName,
        recommended_action: "Restore the canonical sibling mcp/network-mcp definitions and retry.",
      }));
      continue;
    }

    if (definition.access !== access) {
      throw new Error(`Network definition access mismatch for ${consoleName}: definition=${definition.access}, console=${access}`);
    }

    server.registerTool(consoleName, {
      description: definition.description,
      inputSchema: definition.inputSchema,
      ...registration,
    }, async (input) => {
      const payload = attachConsoleExecutionCorrelation(definition.capabilityName, definition.toPayload(input));
      return textResult(await callNetworkDomainWorker(definition, payload));
    });
  }
}

export function inspectNetworkDomainDefinitionLoad(): Record<string, unknown> {
  const loaded = loadNetworkDomainDefinitions();
  return {
    ok: loaded.error === null,
    status: loaded.error === null ? "NETWORK_DOMAIN_DEFINITIONS_READY" : "NETWORK_DOMAIN_DEFINITIONS_UNAVAILABLE",
    path: loaded.path,
    definition_count: loaded.definitions.length,
    expected_definition_count: consoleNetworkDomainToolNames.length,
    console_names: loaded.definitions.map((definition) => definition.consoleName),
    error: loaded.error,
  };
}

function loadNetworkDomainDefinitions(): LoadedNetworkDefinitions {
  const path = resolveNetworkDomainDefinitionsPath();

  try {
    const module = requireFromHere(path) as Partial<NetworkDomainDefinitionsModule>;
    if (typeof module.createNetworkCoreDomainToolDefinitions !== "function") {
      return {
        path,
        definitions: [],
        error: "createNetworkCoreDomainToolDefinitions export is missing.",
      };
    }

    const definitions = module.createNetworkCoreDomainToolDefinitions();
    if (!Array.isArray(definitions)) {
      return {
        path,
        definitions: [],
        error: "createNetworkCoreDomainToolDefinitions did not return an array.",
      };
    }

    return {
      path,
      definitions,
      error: null,
    };
  } catch (error) {
    return {
      path,
      definitions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveNetworkDomainDefinitionsPath(): string {
  const configured = process.env.NETWORK_MCP_CORE_DOMAIN_DEFINITIONS_PATH;
  if (typeof configured === "string" && configured.trim()) {
    return resolve(configured.trim());
  }

  return resolve(process.cwd(), "..", "network-mcp", "mcp-server", "src", "core-domain-tool-definitions.cjs");
}

function attachConsoleExecutionCorrelation(capabilityName: string, rawPayload: unknown): unknown {
  if (!correlationCapabilities.has(capabilityName) || !isRecord(rawPayload)) {
    return rawPayload;
  }

  const correlationId = getMcpRequestContext()?.correlationId ?? null;
  if (!correlationId) {
    return rawPayload;
  }

  const existing = isRecord(rawPayload.correlation) ? rawPayload.correlation : {};
  return {
    ...rawPayload,
    correlation: {
      ...existing,
      invocationId: typeof existing.invocationId === "string" && existing.invocationId.trim()
        ? existing.invocationId
        : correlationId,
    },
  };
}

async function callNetworkDomainWorker(definition: NetworkDomainDefinition, payload: unknown): Promise<Record<string, unknown>> {
  const worker = resolveNetworkWorkerUrl();
  if (!worker.ok) {
    return {
      ok: false,
      status: "NETWORK_BROWSER_WORKER_CONFIGURATION_INVALID",
      error: worker.error,
      capability: definition.capabilityName,
    };
  }

  const timeoutMs = resolveNetworkWorkerTimeout(payload);
  const body = JSON.stringify(payload ?? {});
  const token = process.env.NETWORK_MCP_BROWSER_WORKER_TOKEN || "";

  try {
    const response = await networkWorkerRequest(worker.url, definition.route, body, token, timeoutMs);
    const parsed = parseJsonObject(response.body);
    if (parsed) {
      return parsed;
    }

    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode >= 200 && response.statusCode < 300
        ? "NETWORK_BROWSER_WORKER_RESPONSE"
        : "NETWORK_BROWSER_WORKER_ERROR",
      capability: definition.capabilityName,
      route: definition.route,
      http_status: response.statusCode,
      body: response.body.slice(0, 2000),
    };
  } catch (error) {
    return {
      ok: false,
      status: "NETWORK_BROWSER_WORKER_DOWN",
      capability: definition.capabilityName,
      route: definition.route,
      worker_url: worker.url.origin,
      error: error instanceof Error ? error.message : String(error),
      recommended_action: "Restore the local Network browser capability worker, then retry the bounded domain operation.",
    };
  }
}

function resolveNetworkWorkerUrl(): { ok: true; url: URL } | { ok: false; error: string } {
  const raw = process.env.NETWORK_MCP_BROWSER_WORKER_URL || "http://127.0.0.1:8791";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:") {
      return { ok: false, error: "Network browser worker URL must use loopback HTTP." };
    }

    const hostname = url.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
      return { ok: false, error: "Network browser worker URL must resolve to loopback." };
    }

    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveNetworkWorkerTimeout(payload: unknown): number {
  const requested = isRecord(payload) && typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
    ? Math.trunc(payload.timeoutMs)
    : 15000;

  return Math.min(Math.max(requested + 5000, 3000), 70000);
}

function networkWorkerRequest(
  workerUrl: URL,
  route: string,
  body: string,
  token: string,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const basePath = workerUrl.pathname.replace(/\/+$/, "");
    const path = `${basePath}${route.startsWith("/") ? route : `/${route}`}`;
    const headers: Record<string, string | number> = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    const req = request({
      protocol: workerUrl.protocol,
      hostname: workerUrl.hostname,
      port: workerUrl.port || 80,
      method: "POST",
      path,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolveRequest({
        statusCode: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });

    req.on("timeout", () => req.destroy(new Error(`Network worker request timed out after ${timeoutMs}ms`)));
    req.on("error", rejectRequest);
    req.end(body);
  });
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = String(raw || "").trim();
  if (!text) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

