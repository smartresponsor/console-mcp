import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { buildConsoleToolRegistration, textResult, truncateText } from "./common.js";

type Input = { url?: string; depth?: number; maxPages?: number; includeAssets?: boolean; maxAssets?: number; timeoutMs?: number; maxBodyBytes?: number };
type Method = "GET" | "HEAD";
type FetchResult = {
  ok: boolean; method: Method; requestUrl: string; finalUrl: string; statusCode: number | null; statusMessage: string | null; contentType: string | null;
  headers: Record<string, string>; redirectChain: Array<{ from: string; statusCode: number; location: string; to: string }>; durationMs: number;
  bodyPreview: string; bodyBytesRead: number; bodyTruncated: boolean; error: string | null;
};
type LinkInfo = { href: string; text: string; resolvedUrl: string | null; sameOrigin: boolean; local: boolean; skippedReason: string | null };
type AssetInfo = { type: "script" | "stylesheet" | "image"; url: string; sameOrigin: boolean; local: boolean; skippedReason: string | null };
type HtmlInfo = {
  title: string | null; metaDescription: string | null; canonical: string | null; h1: string[]; h2: string[]; links: LinkInfo[];
  forms: Array<{ method: string; action: string | null; resolvedAction: string | null; inputNames: string[] }>; scripts: AssetInfo[]; stylesheets: AssetInfo[];
  images: AssetInfo[]; buttons: string[]; visibleTextPreview: string; diagnostics: string[];
};

const DEFAULT_URL = "http://127.0.0.1:8000/";
const MAX_REDIRECTS = 10;
const MAX_ITEMS = 120;
const TEXT_PREVIEW_BYTES = 4000;
const TEXTUAL_CT = /^(text\/)|(?:json|xml|html|javascript|ecmascript|x-www-form-urlencoded)/i;
const SENSITIVE_HEADER = new Set(["authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token"]);
const SENSITIVE_QUERY = /(token|secret|password|passwd|pwd|key|auth|session|csrf|xsrf|signature|sig|code|state)/i;
const ACTION_PATH = /(^|\/)(logout|delete|remove|destroy|drop|truncate|purge|reset|rebuild|seed|impersonate|switch-user|disable|enable|ban|unban)(\/|$)/i;
const inputSchema = z.object({
  url: z.string().min(1).optional(),
  depth: z.number().int().min(0).max(3).optional(),
  maxPages: z.number().int().min(1).max(100).optional(),
  includeAssets: z.boolean().optional(),
  maxAssets: z.number().int().min(0).max(200).optional(),
  timeoutMs: z.number().int().min(1000).max(30000).optional(),
  maxBodyBytes: z.number().int().min(1024).max(2 * 1024 * 1024).optional(),
}).strict();

export function registerLocalhostTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.localhost", {
    description: "Read and diagnose localhost HTTP pages with safe GET/HEAD access, redirects, HTML extraction, same-origin crawling, and asset checks.",
    inputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await inspectLocalhost(input)));
}

async function inspectLocalhost(input: Input): Promise<Record<string, unknown>> {
  const options = { startUrl: parseLocalUrl(input.url ?? DEFAULT_URL), depth: input.depth ?? 1, maxPages: input.maxPages ?? 25, includeAssets: input.includeAssets ?? true, maxAssets: input.maxAssets ?? 50, timeoutMs: input.timeoutMs ?? 10000, maxBodyBytes: input.maxBodyBytes ?? 512 * 1024 };
  const startedAt = Date.now();
  const pages: Array<{ url: string; depth: number; fetch: FetchResult; html: HtmlInfo | null }> = [];
  const assets: Array<{ url: string; type: AssetInfo["type"]; fetch: FetchResult }> = [];
  const skippedLinks: Array<{ url: string; reason: string }> = [];
  const queue: Array<{ url: URL; depth: number }> = [{ url: options.startUrl, depth: 0 }];
  const queued = new Set([canonical(options.startUrl)]);
  const visited = new Set<string>();
  const probedAssets = new Set<string>();

  while (queue.length > 0 && pages.length < options.maxPages) {
    const current = queue.shift();
    if (!current || visited.has(canonical(current.url))) continue;
    visited.add(canonical(current.url));

    const fetch = await fetchLocal(current.url, "GET", options.timeoutMs, options.maxBodyBytes, true);
    const html = fetch.bodyPreview && fetch.contentType !== null && /html/i.test(fetch.contentType) ? inspectHtml(new URL(fetch.finalUrl), fetch.bodyPreview) : null;
    pages.push({ url: sanitizeUrl(current.url), depth: current.depth, fetch, html });

    if (html && options.includeAssets) {
      for (const asset of [...html.stylesheets, ...html.scripts, ...html.images]) {
        if (assets.length >= options.maxAssets || asset.skippedReason || !asset.local) continue;
        const assetUrl = new URL(asset.url);
        const key = canonical(assetUrl);
        if (probedAssets.has(key)) continue;
        probedAssets.add(key);
        const head = await fetchLocal(assetUrl, "HEAD", options.timeoutMs, 0, true);
        assets.push({ url: sanitizeUrl(assetUrl), type: asset.type, fetch: head.statusCode === 405 || head.statusCode === 501 ? await fetchLocal(assetUrl, "GET", options.timeoutMs, 8192, true) : head });
      }
    }

    if (!html || current.depth >= options.depth) continue;
    for (const link of html.links) {
      if (!link.resolvedUrl) continue;
      const nextUrl = new URL(link.resolvedUrl);
      const reason = link.skippedReason ?? readOnlySkipReason(nextUrl);
      if (reason) { skippedLinks.push({ url: sanitizeUrl(nextUrl), reason }); continue; }
      if (!link.local || !link.sameOrigin) continue;
      const key = canonical(nextUrl);
      if (visited.has(key) || queued.has(key)) continue;
      queued.add(key);
      queue.push({ url: nextUrl, depth: current.depth + 1 });
    }
  }

  const pageFailures = pages.filter((page) => !successStatus(page.fetch.statusCode));
  const assetFailures = assets.filter((asset) => !successStatus(asset.fetch.statusCode));
  const htmlDiagnostics = pages.flatMap((page) => page.html?.diagnostics.map((message) => ({ url: page.url, message })) ?? []);

  return {
    ok: pageFailures.length === 0 && assetFailures.length === 0,
    mode: "safe-localhost-readonly",
    policy: { allowedSchemes: ["http", "https"], allowedHosts: ["localhost", "*.localhost", "127.0.0.0/8", "::1"], methods: ["GET", "HEAD"], externalNetwork: "denied", unsafeActionLinks: "skipped", sensitiveHeadersAndQueryParams: "redacted" },
    request: { startUrl: sanitizeUrl(options.startUrl), depth: options.depth, maxPages: options.maxPages, includeAssets: options.includeAssets, maxAssets: options.maxAssets, timeoutMs: options.timeoutMs, maxBodyBytes: options.maxBodyBytes },
    summary: { durationMs: Date.now() - startedAt, pageCount: pages.length, pageFailureCount: pageFailures.length, assetCount: assets.length, assetFailureCount: assetFailures.length, skippedLinkCount: skippedLinks.length, htmlDiagnosticCount: htmlDiagnostics.length, truncatedByMaxPages: queue.length > 0, truncatedByMaxAssets: options.includeAssets && probedAssets.size > assets.length },
    failures: { pages: pageFailures.map((page) => ({ url: page.url, statusCode: page.fetch.statusCode, error: page.fetch.error })), assets: assetFailures.map((asset) => ({ url: asset.url, type: asset.type, statusCode: asset.fetch.statusCode, error: asset.fetch.error })) },
    htmlDiagnostics,
    skippedLinks: skippedLinks.slice(0, MAX_ITEMS),
    pages,
    assets,
  };
}

async function fetchLocal(url: URL, method: Method, timeoutMs: number, maxBodyBytes: number, followRedirects: boolean): Promise<FetchResult> {
  assertLocalUrl(url);
  const startedAt = Date.now();
  const redirectChain: FetchResult["redirectChain"] = [];
  let currentUrl = new URL(url.href);

  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    const response = await requestOnce(currentUrl, method, timeoutMs, maxBodyBytes);
    const statusCode = response.statusCode;
    const location = response.headers.location;
    if (!followRedirects || !redirectStatus(statusCode) || !location) {
      return { ok: response.error === null && successStatus(statusCode), method, requestUrl: sanitizeUrl(url), finalUrl: sanitizeUrl(currentUrl), statusCode, statusMessage: response.statusMessage, contentType: response.contentType, headers: response.headers, redirectChain, durationMs: Date.now() - startedAt, bodyPreview: response.bodyPreview, bodyBytesRead: response.bodyBytesRead, bodyTruncated: response.bodyTruncated, error: response.error };
    }
    const nextUrl = parseLocalUrl(location, currentUrl);
    redirectChain.push({ from: sanitizeUrl(currentUrl), statusCode, location: sanitizeMaybeRelative(location), to: sanitizeUrl(nextUrl) });
    currentUrl = nextUrl;
  }

  return { ok: false, method, requestUrl: sanitizeUrl(url), finalUrl: sanitizeUrl(currentUrl), statusCode: null, statusMessage: null, contentType: null, headers: {}, redirectChain, durationMs: Date.now() - startedAt, bodyPreview: "", bodyBytesRead: 0, bodyTruncated: false, error: `Too many redirects; limit is ${MAX_REDIRECTS}.` };
}

function requestOnce(url: URL, method: Method, timeoutMs: number, maxBodyBytes: number): Promise<Omit<FetchResult, "ok" | "method" | "requestUrl" | "finalUrl" | "redirectChain" | "durationMs">> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bodyBytesRead = 0;
    let bodyTruncated = false;
    let settled = false;
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const agent = url.protocol === "https:" ? new HttpsAgent({ rejectUnauthorized: false }) : undefined;
    const req = requestFn(url, { method, timeout: timeoutMs, agent, headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.5", "User-Agent": "console-mcp-localhost/1.0 readonly-diagnostic" } }, (res) => {
      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytesRead += buffer.length;
        if (method === "HEAD" || maxBodyBytes <= 0) { bodyTruncated ||= buffer.length > 0; return; }
        const currentBytes = chunks.reduce((sum, item) => sum + item.length, 0);
        const remaining = maxBodyBytes - currentBytes;
        if (remaining <= 0) { bodyTruncated = true; return; }
        chunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
        bodyTruncated ||= buffer.length > remaining;
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        const headers = sanitizeHeaders(res.headers);
        const contentType = headers["content-type"] ?? null;
        const rawBody = Buffer.concat(chunks);
        const preview = contentType === null || TEXTUAL_CT.test(contentType) ? truncateText(rawBody.toString("utf8"), 6000) : { text: rawBody.length > 0 ? `[${rawBody.length} binary bytes omitted]` : "", truncated: false };
        resolve({ statusCode: res.statusCode ?? null, statusMessage: res.statusMessage ?? null, contentType, headers, bodyPreview: preview.text, bodyBytesRead, bodyTruncated: bodyTruncated || preview.truncated, error: null });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms.`)));
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ statusCode: null, statusMessage: null, contentType: null, headers: {}, bodyPreview: "", bodyBytesRead, bodyTruncated, error: error instanceof Error ? error.message : String(error) });
    });
    req.end();
  });
}

function inspectHtml(baseUrl: URL, html: string): HtmlInfo {
  const title = clean(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const h1 = textTags(html, "h1", 20);
  const h2 = textTags(html, "h2", 30);
  const links = tags(html, "a").flatMap((tag) => {
    const href = attr(tag, "href");
    if (!href) return [];
    const resolved = resolveLink(href, baseUrl);
    return [{ href: sanitizeMaybeRelative(href), text: truncateText(clean(stripHtml(tag)) ?? "", 200).text, resolvedUrl: resolved.url ? sanitizeUrl(resolved.url) : null, sameOrigin: resolved.url ? resolved.url.origin === baseUrl.origin : false, local: resolved.url ? isLocalUrl(resolved.url) : false, skippedReason: resolved.reason }];
  });
  const forms = formInfo(html, baseUrl);
  const scripts = assetInfo(html, baseUrl, "script", "src", "script");
  const stylesheets = tags(html, "link").filter((tag) => /stylesheet/i.test(attr(tag, "rel") ?? "")).flatMap((tag) => {
    const href = attr(tag, "href");
    return href ? [assetFromRaw(href, baseUrl, "stylesheet")] : [];
  });
  const images = assetInfo(html, baseUrl, "img", "src", "image");
  const externalAssets = [...scripts, ...stylesheets, ...images].filter((asset) => !asset.local).length;
  const diagnostics = [
    ...(title ? [] : ["Missing <title>."]),
    ...(h1.length > 0 ? [] : ["Missing <h1>."]),
    ...forms.filter((form) => form.method !== "GET").map((form) => `Form uses non-read method ${form.method}; console.localhost will inspect it but will not submit it.`),
    ...(links.some((link) => !link.resolvedUrl) ? [`Found ${links.filter((link) => !link.resolvedUrl).length} unresolved or unsupported link URL(s).`] : []),
    ...(externalAssets > 0 ? [`Found ${externalAssets} external asset URL(s); fetching external network is denied.`] : []),
  ];

  return { title, metaDescription: clean(firstTagAttr(html, "meta", "content", (tag) => /name\s*=\s*["']description["']/i.test(tag))), canonical: resolveAttrUrl(firstTagAttr(html, "link", "href", (tag) => /rel\s*=\s*["'][^"']*canonical/i.test(tag)), baseUrl), h1, h2, links, forms, scripts, stylesheets, images, buttons: textTags(html, "button", 50), visibleTextPreview: truncateText(clean(stripHtml(html)) ?? "", TEXT_PREVIEW_BYTES).text, diagnostics };
}

function formInfo(html: string, baseUrl: URL): HtmlInfo["forms"] {
  const forms: HtmlInfo["forms"] = [];
  const pattern = /<form\b([\s\S]*?)(?:>([\s\S]*?)<\/form>|\/?>)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && forms.length < 50) {
    const openTag = match[0].split(">")[0] ?? match[0];
    const inner = match[2] ?? "";
    const action = attr(openTag, "action");
    forms.push({ method: (attr(openTag, "method") ?? "GET").toUpperCase(), action: action ? sanitizeMaybeRelative(action) : null, resolvedAction: action ? resolveAttrUrl(action, baseUrl) : sanitizeUrl(baseUrl), inputNames: ["input", "textarea", "select", "button"].flatMap((name) => tags(inner, name).map((tag) => attr(tag, "name")).filter((value): value is string => Boolean(value))).slice(0, 100) });
  }
  return forms;
}

function assetInfo(html: string, baseUrl: URL, tagName: string, attrName: string, type: AssetInfo["type"]): AssetInfo[] {
  return tags(html, tagName).flatMap((tag) => {
    const raw = attr(tag, attrName);
    return raw ? [assetFromRaw(raw, baseUrl, type)] : [];
  });
}

function assetFromRaw(raw: string, baseUrl: URL, type: AssetInfo["type"]): AssetInfo {
  const resolved = resolveLink(raw, baseUrl);
  return { type, url: resolved.url ? sanitizeUrl(resolved.url) : sanitizeMaybeRelative(raw), sameOrigin: resolved.url ? resolved.url.origin === baseUrl.origin : false, local: resolved.url ? isLocalUrl(resolved.url) : false, skippedReason: resolved.reason };
}

function resolveLink(raw: string, baseUrl: URL): { url: URL | null; reason: string | null } {
  const text = raw.trim();
  if (!text) return { url: null, reason: "empty_url" };
  if (text.startsWith("#")) return { url: null, reason: "fragment_only" };
  if (/^(javascript|mailto|tel|sms|data|blob):/i.test(text)) return { url: null, reason: "unsupported_scheme" };
  try {
    const url = new URL(text, baseUrl);
    url.hash = "";
    if (url.protocol !== "http:" && url.protocol !== "https:") return { url: null, reason: "unsupported_scheme" };
    if (!isLocalUrl(url)) return { url, reason: "external_host_denied" };
    return { url, reason: readOnlySkipReason(url) };
  } catch {
    return { url: null, reason: "invalid_url" };
  }
}

function readOnlySkipReason(url: URL): string | null {
  const text = `${url.pathname}${url.search}`;
  if (ACTION_PATH.test(text)) return "potential_action_link";
  for (const [key, value] of url.searchParams.entries()) {
    const pair = `${key}=${value}`.toLowerCase();
    if (key.toLowerCase() === "_method" && /^(post|put|patch|delete)$/i.test(value)) return "method_override_action_link";
    if (/\b(action|do|operation|op)=/.test(pair) && /(delete|remove|destroy|purge|truncate|reset|logout)/.test(pair)) return "query_action_link";
  }
  return null;
}

function tags(html: string, tagName: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<${tagName}\\b[\\s\\S]*?>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && out.length < MAX_ITEMS) out.push(match[0]);
  return out;
}

function textTags(html: string, tagName: string, limit: number): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && out.length < limit) {
    const text = clean(stripHtml(match[1] ?? ""));
    if (text) out.push(text);
  }
  return out;
}

function firstMatch(text: string, pattern: RegExp): string | null { return pattern.exec(text)?.[1] ?? null; }
function firstTagAttr(html: string, tagName: string, attrName: string, predicate: (tag: string) => boolean): string | null {
  for (const tag of tags(html, tagName)) if (predicate(tag)) { const value = attr(tag, attrName); if (value) return value; }
  return null;
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function resolveAttrUrl(raw: string | null, baseUrl: URL): string | null {
  if (!raw) return null;
  try { return sanitizeUrl(new URL(raw, baseUrl)); } catch { return sanitizeMaybeRelative(raw); }
}

function stripHtml(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ");
}

function clean(text: string | null): string | null {
  if (!text) return null;
  const value = text.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : null;
}

function parseLocalUrl(raw: string, base?: URL): URL { const url = new URL(raw, base); url.hash = ""; assertLocalUrl(url); return url; }
function assertLocalUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https localhost URLs are allowed: ${sanitizeUrl(url)}`);
  if (url.username || url.password) throw new Error("Credentials in localhost URLs are not allowed.");
  if (!isLocalUrl(url)) throw new Error(`Only loopback localhost hosts are allowed: ${sanitizeUrl(url)}`);
}

function isLocalUrl(url: URL): boolean {
  const host = url.hostname.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0:0:0:0:0:0:0:1" || loopbackIpv4(host);
}

function loopbackIpv4(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number.parseInt(part, 10) >= 0 && Number.parseInt(part, 10) <= 255);
}

function redirectStatus(status: number | null): status is number { return status !== null && status >= 300 && status < 400; }
function successStatus(status: number | null): boolean { return status !== null && status >= 200 && status < 400; }

function sanitizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (SENSITIVE_HEADER.has(lower)) out[lower] = "[redacted]";
    else if (Array.isArray(value)) out[lower] = value.join(", ");
    else if (value !== undefined) out[lower] = String(value);
  }
  return out;
}

function canonical(url: URL): string { const clone = new URL(url.href); clone.hash = ""; return clone.href; }
function sanitizeUrl(url: URL): string {
  const clone = new URL(url.href);
  clone.username = "";
  clone.password = "";
  for (const key of Array.from(clone.searchParams.keys())) if (SENSITIVE_QUERY.test(key)) clone.searchParams.set(key, "[redacted]");
  return clone.href;
}

function sanitizeMaybeRelative(raw: string): string { try { return sanitizeUrl(new URL(raw)); } catch { return truncateText(raw, 500).text; } }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
