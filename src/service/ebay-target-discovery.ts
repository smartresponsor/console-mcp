import type { EbayStoreId } from "./ebay-store-routing.js";
export type BrowserPage = Readonly<{ id: string; port: number; type: string; url: string; title: string }>;
export type TargetDiscovery = Readonly<{ ok: true; targetId: string; port: number; url: string }> | Readonly<{ ok: false; reason: string }>;
/** Read-only selection; browser account attestation remains a separate required gate. */
export function discoverEbayDraftTarget(pages: readonly BrowserPage[], allowedPort: number, storeId: EbayStoreId): TargetDiscovery {
  if (storeId !== "parts" && storeId !== "toner" && storeId !== "general") return { ok: false, reason: "INVALID_STORE" };
  const matches = pages.filter(page => {
    if (page.port !== allowedPort || page.type !== "page" || !/^[0-9A-F]{32}$/i.test(page.id)) return false;
    try { const url = new URL(page.url); return url.protocol === "https:" && url.hostname === "www.ebay.com" && url.pathname === "/sh/lst/drafts" && !url.username && !url.password; } catch { return false; }
  });
  if (matches.length === 0) return { ok: false, reason: "DRAFTS_TARGET_NOT_FOUND" };
  if (matches.length !== 1) return { ok: false, reason: "MULTIPLE_DRAFTS_TARGETS" };
  return { ok: true, targetId: matches[0].id, port: allowedPort, url: matches[0].url };
}
