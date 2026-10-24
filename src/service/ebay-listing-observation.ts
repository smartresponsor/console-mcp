import type { ListingEvidence, ListingEvidenceResult } from "./ebay-listing-evidence.js";
import { listingCandidatesFromEvidence } from "./ebay-listing-evidence.js";
import type { ListingKind } from "./ebay-listing-selection.js";
import type { EbayStoreId } from "./ebay-store-routing.js";
export type BrowserListingObservation = Readonly<{ url: string; itemSpecifics: ReadonlyArray<Readonly<{ name: string; value: string }>>; condition: "New" | "Used" | "Unknown"; kind: ListingKind; storeId?: EbayStoreId; captureComplete: boolean }>;
/** Accept only explicitly captured MPN item specifics; no title or free-text inference. */
export function listingCandidatesFromObservations(observations: readonly BrowserListingObservation[], searchComplete: boolean): ListingEvidenceResult {
  if (!searchComplete) return { ok: false, reason: "SEARCH_INCOMPLETE" };
  const evidence: ListingEvidence[] = [];
  for (const observation of observations) {
    if (!observation.captureComplete) return { ok: false, reason: "CAPTURE_INCOMPLETE" };
    const mpnFields = observation.itemSpecifics.filter(field => /^MPN$/i.test(field.name.trim()));
    if (mpnFields.length !== 1) return { ok: false, reason: "MPN_FIELD_NOT_UNIQUE" };
    evidence.push({ kind: observation.kind, itemUrl: observation.url, verifiedMpn: mpnFields[0].value, condition: observation.condition, storeId: observation.storeId, mpnEvidenceSource: "ITEM_SPECIFICS" });
  }
  return listingCandidatesFromEvidence(evidence, true);
}
