import { discoverEbayDraftTarget, type BrowserPage, type TargetDiscovery } from "./ebay-target-discovery.js";
import { verifyEbayStoreSession, type EbayBrowserEvidence } from "./ebay-store-session.js";
import type { EbayStore } from "./ebay-store-routing.js";
/** Exact target selection requires independent, fresh account and process evidence. */
export function discoverVerifiedEbayDraftTarget(pages: readonly BrowserPage[], port: number, store: EbayStore, evidence: EbayBrowserEvidence | null, nowEpochMs: number = Date.now()): TargetDiscovery {
  const decision = verifyEbayStoreSession(store, evidence, nowEpochMs);
  if (!decision.ok) return { ok: false, reason: decision.reason };
  if (Number(new URL(evidence!.endpoint).port) !== port) return { ok: false, reason: "PORT_MISMATCH" };
  const matching = pages.filter(page => page.id === decision.targetId);
  if (matching.length !== 1) return { ok: false, reason: "TARGET_NOT_UNIQUE_OR_MISSING" };
  if (matching[0].url !== evidence!.url) return { ok: false, reason: "TARGET_URL_CHANGED" };
  return discoverEbayDraftTarget(matching, port, store.id);
}
