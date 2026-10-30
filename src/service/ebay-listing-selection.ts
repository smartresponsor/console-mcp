import { normalizePartNumber, type EbayStoreId } from "./ebay-store-routing.js";
export type ListingKind = "OWN_ACTIVE" | "OWN_SOLD" | "OWN_DRAFT" | "EXTERNAL_ACTIVE";
export type ListingCandidate = Readonly<{ kind: ListingKind; storeId?: EbayStoreId; itemId: string; mpn: string; condition: "New" | "Used" | "Unknown"; brand?: string | null; quantity?: number }>;
export type ListingAction = "PREPARE_QUANTITY_UPDATE" | "PREPARE_RELIST" | "REUSE_DRAFT" | "SELL_SIMILAR_DRAFT" | "CREATE_NEW_DRAFT";
export type ListingSelection = Readonly<{ ok: true; action: ListingAction; itemId?: string }> | Readonly<{ ok: false; reason: string }>;
/** Exact-MPN-first decision only; never performs listing writes or publication. */
export function selectEbayListing(mpnInput: string, storeId: EbayStoreId, candidates: readonly ListingCandidate[], completeLookup: boolean): ListingSelection {
  const mpn = normalizePartNumber(mpnInput);
  if (!mpn) return { ok: false, reason: "MPN_REQUIRED" };
  if (!completeLookup) return { ok: false, reason: "LOOKUP_INCOMPLETE" };
  const exact = candidates.filter(c => normalizePartNumber(c.mpn) === mpn && c.condition === "New" && (c.kind === "EXTERNAL_ACTIVE" || c.storeId === storeId));
  const choices: ReadonlyArray<readonly [ListingKind, ListingAction]> = [
    ["OWN_ACTIVE", "PREPARE_QUANTITY_UPDATE"],
    ["OWN_SOLD", "PREPARE_RELIST"],
    ["OWN_DRAFT", "REUSE_DRAFT"],
    ["EXTERNAL_ACTIVE", "SELL_SIMILAR_DRAFT"],
  ];
  for (const [kind, action] of choices) {
    const matches = exact.filter(c => c.kind === kind);
    if (matches.length > 1) return { ok: false, reason: "AMBIGUOUS_EXACT_MPN" };
    if (matches.length === 1) {
      if (!/^\d{10,20}$/.test(matches[0].itemId)) return { ok: false, reason: "INVALID_ITEM_ID" };
      return { ok: true, action, itemId: matches[0].itemId };
    }
  }
  return { ok: true, action: "CREATE_NEW_DRAFT" };
}
