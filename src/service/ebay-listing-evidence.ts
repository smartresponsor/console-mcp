import { normalizePartNumber } from "./ebay-store-routing.js";
import type { ListingCandidate, ListingKind } from "./ebay-listing-selection.js";
import type { EbayStoreId } from "./ebay-store-routing.js";
export type ListingEvidence = Readonly<{ kind: ListingKind; itemUrl: string; verifiedMpn: string | null; condition: "New" | "Used" | "Unknown"; storeId?: EbayStoreId; mpnEvidenceSource: "ITEM_SPECIFICS" | "SELLER_HUB" | "TITLE_ONLY" | "UNKNOWN" }>;
export type ListingEvidenceResult = Readonly<{ ok: true; candidates: readonly ListingCandidate[] }> | Readonly<{ ok: false; reason: string }>;
/** Converts structured browser observations, never title search matches, to exact-MPN candidates. */
export function listingCandidatesFromEvidence(records: readonly ListingEvidence[], lookupComplete: boolean): ListingEvidenceResult {
  if (!lookupComplete) return { ok: false, reason: "LOOKUP_INCOMPLETE" };
  const candidates: ListingCandidate[] = [];
  for (const record of records) {
    if (record.mpnEvidenceSource !== "ITEM_SPECIFICS" && record.mpnEvidenceSource !== "SELLER_HUB") return { ok: false, reason: "MPN_EVIDENCE_REQUIRED" };
    const mpn = normalizePartNumber(record.verifiedMpn);
    if (!mpn) return { ok: false, reason: "INVALID_VERIFIED_MPN" };
    let url: URL;
    try { url = new URL(record.itemUrl); } catch { return { ok: false, reason: "INVALID_ITEM_URL" }; }
    if (url.protocol !== "https:" || url.hostname !== "www.ebay.com" || url.username || url.password || url.port || url.hash) return { ok: false, reason: "INVALID_ITEM_ORIGIN" };
    const itemId = /^\/itm\/(?:[^/]+\/)?(\d{10,20})\/?$/.exec(url.pathname)?.[1] ?? (/^\/lstng$/.test(url.pathname) ? url.searchParams.get("draftId") : null);
    if (!itemId || !/^\d{10,20}$/.test(itemId)) return { ok: false, reason: "ITEM_ID_NOT_VERIFIED" };
    if (record.kind !== "EXTERNAL_ACTIVE" && !record.storeId) return { ok: false, reason: "OWN_STORE_REQUIRED" };
    candidates.push({ kind: record.kind, itemId, mpn, condition: record.condition, storeId: record.storeId });
  }
  return { ok: true, candidates };
}
