import { resolveMcpSiblingRepository } from "../service/mcp-sibling-repository.js";
import { request } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMcpRequestContext } from "../Infrastructure/Diagnostics/RequestContext.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";
import { assertConsoleToolCatalogContains } from "./catalog.js";

type WebDomainDefinition = {
  canonicalName: string;
  consoleName: string;
  route: string;
  capabilityName: string;
  access: "read" | "write";
  description: string;
  inputSchema: z.ZodTypeAny;
  toPayload: (input: unknown) => unknown;
};

type WebDomainDefinitionsModule = {
  createWebCoreDomainToolDefinitions: () => readonly WebDomainDefinition[];
};

type LoadedWebDefinitions = {
  path: string;
  definitions: readonly WebDomainDefinition[];
  error: string | null;
};

const requireFromHere = createRequire(import.meta.url);

export const consoleWebDomainToolNames = [
  "read_.web.browser.targets",
  "write.web.browser.bind",
  "write.web.target.open",
  "write.web.job.open",
  "read_.web.chatgpt.snapshot",
  "read_.web.page.capture",
  "read_.web.page.capture.dom",
  "read_.web.page.capture.form",
  "read_.web.page.wait",
  "read_.web.form.inspect",
  "write.web.page.click",
  "read_.web.form.extract",
  "write.web.form.proposal.preview",
  "write.web.form.fill",
  "write.web.form.upload",
  "write.web.form.review.snapshot",
  "write.web.form.submit",
] as const;

const browserSessionSchema = z.enum(["isolated", "visible", "background", "grants"]).optional();

const correlationCapabilities = new Set([
  "web.click",
  "web.fill_after_approval",
  "web.upload_artifact",
  "web.submit_after_approval",
]);

export function registerWebDomainBridgeTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  assertConsoleToolCatalogContains(consoleWebDomainToolNames);

  const loaded = loadWebDomainDefinitions();
  const definitionsByConsoleName = new Map(loaded.definitions.map((definition) => [definition.consoleName, definition]));

  for (const consoleName of consoleWebDomainToolNames) {
    const definition = definitionsByConsoleName.get(consoleName);
    const access: "read" | "write" = consoleName.startsWith("read_.") ? "read" : "write";
    const registration = access === "write"
      ? buildConsoleMutationToolRegistration(authConfig)
      : buildConsoleToolRegistration(authConfig);

    if (!definition) {
      server.registerTool(consoleName, {
        description: "Web domain capability is unavailable because the canonical Web definitions could not be loaded.",
        inputSchema: z.object({}).passthrough(),
        ...registration,
      }, async () => textResult({
        ok: false,
        status: "WEB_DOMAIN_DEFINITIONS_UNAVAILABLE",
        definitions_path: loaded.path,
        error: loaded.error,
        capability: consoleName,
        recommended_action: "Restore the canonical sibling mcp/Browsing definitions and retry.",
      }));
      continue;
    }

    if (definition.access !== access) {
      throw new Error(`Web definition access mismatch for ${consoleName}: definition=${definition.access}, console=${access}`);
    }

    server.registerTool(consoleName, {
      description: definition.description,
      inputSchema: typeof (definition.inputSchema as z.ZodObject<z.ZodRawShape>).extend === "function"
        ? (definition.inputSchema as z.ZodObject<z.ZodRawShape>).extend({ browserSession: browserSessionSchema, ...(["read_.web.page.capture", "write.web.form.proposal.preview", "write.web.target.open"].includes(consoleName) ? { targetId: z.string().regex(/^[A-Fa-f0-9]{32}$/).optional() } : {}) })
        : definition.inputSchema,
      ...registration,
    }, async (input) => {
      const rawInput = isRecord(input) ? input : {};
      const requestedSession = rawInput.browserSession === "grants" ? "grants" : rawInput.browserSession === "visible" || (!rawInput.browserSession && consoleName === "write.web.form.proposal.preview") || (!rawInput.browserSession && consoleName.startsWith("write.web.form.") && typeof rawInput.expectedTargetId === "string") ? "visible" : "isolated";
      const { browserSession: _browserSession, ...domainInput } = rawInput;
      const payload = attachConsoleExecutionCorrelation(definition.capabilityName, definition.toPayload(domainInput));
      if (requestedSession === "grants" && consoleName === "write.web.browser.bind" && typeof domainInput.targetId === "string") {
        return textResult(await callWebDomainWorker(definition, payload, "grants"));
      }
      if (consoleName === "write.web.browser.bind" && typeof domainInput.targetId === "string") {
        const targetId = domainInput.targetId;
        const matches: Array<"isolated" | "visible"> = [];
        for (const session of ["isolated", "visible"] as const) {
          const inventory = await callWebDomainWorker({
            ...definition,
            route: "/browser-targets",
            capabilityName: "web.browser_targets",
            access: "read",
          }, {}, session);
          if (inventory.ok !== true || !Array.isArray(inventory.targets)) continue;
          if (inventory.targets.some((target: unknown) => isRecord(target)
            && (target.targetId === targetId || target.id === targetId))) {
            matches.push(session);
          }
        }
        if (matches.length !== 1) {
          return textResult({
            ok: false,
            status: matches.length === 0 ? "WEB_TARGET_NOT_FOUND_IN_ANY_SESSION" : "WEB_TARGET_AMBIGUOUS_SESSION",
            targetId,
            searchedSessions: ["isolated", "visible"],
            automatic_retry_allowed: false,
          });
        }
        return textResult(await callWebDomainWorker(definition, payload, matches[0]));
      }
      if (consoleName === "write.web.target.open" && typeof domainInput.targetId === "string") {
        return textResult(await callWebDomainWorker(definition, { ...(isRecord(payload) ? payload : {}), targetId: domainInput.targetId }, requestedSession === "grants" ? "grants" : "visible"));
      }
      if (consoleName === "write.web.page.click" && typeof domainInput.expectedTargetId === "string") {
        return textResult(await callWebDomainWorker(definition, payload, requestedSession === "grants" ? "grants" : "visible"));
      }
      return textResult(await callWebDomainWorker(definition, payload, requestedSession));
    });
  }
}

export function inspectWebDomainDefinitionLoad(): Record<string, unknown> {
  const loaded = loadWebDomainDefinitions();
  return {
    ok: loaded.error === null,
    status: loaded.error === null ? "WEB_DOMAIN_DEFINITIONS_READY" : "WEB_DOMAIN_DEFINITIONS_UNAVAILABLE",
    path: loaded.path,
    definition_count: loaded.definitions.length,
    expected_definition_count: consoleWebDomainToolNames.length,
    console_names: loaded.definitions.map((definition) => definition.consoleName),
    error: loaded.error,
  };
}

function loadWebDomainDefinitions(): LoadedWebDefinitions {
  const path = resolveWebDomainDefinitionsPath();

  try {
    const module = requireFromHere(path) as Partial<WebDomainDefinitionsModule>;
    if (typeof module.createWebCoreDomainToolDefinitions !== "function") {
      return {
        path,
        definitions: [],
        error: "createWebCoreDomainToolDefinitions export is missing.",
      };
    }

    const definitions = module.createWebCoreDomainToolDefinitions();
    if (!Array.isArray(definitions)) {
      return {
        path,
        definitions: [],
        error: "createWebCoreDomainToolDefinitions did not return an array.",
      };
    }

    const names = new Set(definitions.map((definition) => definition.consoleName));
    if (definitions.length !== consoleWebDomainToolNames.length
        || names.size !== consoleWebDomainToolNames.length
        || consoleWebDomainToolNames.some((name) => !names.has(name))
        || definitions.some((definition) => !definition.canonicalName?.startsWith("web.")
          || !definition.capabilityName?.startsWith("web."))) {
      return { path, definitions: [], error: "Canonical Web definitions must contain all 17 unique Web tools." };
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

function resolveWebDomainDefinitionsPath(): string {
  const configured = process.env.BROWSER_MCP_CORE_DOMAIN_DEFINITIONS_PATH;
  if (typeof configured === "string" && configured.trim()) {
    return resolve(configured.trim());
  }

  return resolve(resolveMcpSiblingRepository("browsing"), "mcp-server", "src", "web-domain-tool-definitions.cjs");
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

async function callWebDomainWorker(definition: WebDomainDefinition, payload: unknown, browserSession: "isolated" | "visible" | "grants" = "isolated"): Promise<Record<string, unknown>> {
  const worker = resolveWebWorkerUrl(browserSession);
  if (!worker.ok) {
    return {
      ok: false,
      status: "WEB_BROWSER_WORKER_CONFIGURATION_INVALID",
      error: worker.error,
      capability: definition.capabilityName,
    };
  }

  const timeoutMs = resolveWebWorkerTimeout(payload);
  const body = JSON.stringify(payload ?? {});
  const token = process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN || "";

  try {
    const response = await webWorkerRequest(worker.url, definition.route, body, token, timeoutMs);
    const parsed = parseJsonObject(response.body);
    if (parsed) {
      if (typeof parsed.status === "number") {
        return { ...parsed, http_status: parsed.status, status: parsed.ok === true ? "WEB_BROWSER_WORKER_RESPONSE" : "WEB_BROWSER_WORKER_ERROR" };
      }
      return parsed;
    }

    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode >= 200 && response.statusCode < 300
        ? "WEB_BROWSER_WORKER_RESPONSE"
        : "WEB_BROWSER_WORKER_ERROR",
      capability: definition.capabilityName,
      route: definition.route,
      http_status: response.statusCode,
      body: response.body.slice(0, 2000),
    };
  } catch (error) {
    return {
      ok: false,
      status: error instanceof Error && /request timed out/.test(error.message)
        ? "WEB_BROWSER_WORKER_TIMEOUT" : "WEB_BROWSER_WORKER_DOWN",
      outcome_unknown: definition.access === "write",
      automatic_retry_allowed: false,
      capability: definition.capabilityName,
      route: definition.route,
      worker_url: worker.url.origin,
      error: error instanceof Error ? error.message : String(error),
      recommended_action: "Check worker/CDP health and recapture the page before deciding whether to retry; a timed-out mutation may still complete.",
    };
  }
}

function resolveWebWorkerUrl(browserSession: "isolated" | "visible" | "background" | "grants" = "isolated"): { ok: true; url: URL } | { ok: false; error: string } {
  const raw = browserSession === "grants" ? "http://127.0.0.1:8797"
    : browserSession === "background"
    ? "http://127.0.0.1:8795"
    : browserSession === "visible"
      ? process.env.BROWSER_MCP_VISIBLE_WORKER_URL || "http://127.0.0.1:8793"
      : process.env.BROWSER_MCP_BROWSER_WORKER_URL || "http://127.0.0.1:8791";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:") {
      return { ok: false, error: "Web browser worker URL must use loopback HTTP." };
    }

    const hostname = url.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
      return { ok: false, error: "Web browser worker URL must resolve to loopback." };
    }

    if (browserSession === "grants" && (url.hostname !== "127.0.0.1" || url.port !== "8797" || url.pathname !== "/" || url.username || url.password)) {
      return { ok: false, error: "Grants runtime is pinned to 127.0.0.1:8797." };
    }
    if (browserSession === "background" && (url.hostname !== "127.0.0.1" || url.port !== "8795" || url.pathname !== "/" || url.username || url.password)) {
      return { ok: false, error: "Background runtime is pinned to 127.0.0.1:8795." };
    }
    if (browserSession === "visible" && (url.hostname !== "127.0.0.1" || url.port !== "8793" || url.pathname !== "/" || url.username || url.password)) {
      return { ok: false, error: "Visible runtime is pinned to 127.0.0.1:8793." };
    }
    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveWebWorkerTimeout(payload: unknown): number {
  const requested = isRecord(payload) && typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
    ? Math.trunc(payload.timeoutMs)
    : 15000;

  return Math.min(Math.max(requested + 5000, 3000), 70000);
}

function webWorkerRequest(
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

    req.on("timeout", () => req.destroy(new Error(`Web worker request timed out after ${timeoutMs}ms`)));
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

