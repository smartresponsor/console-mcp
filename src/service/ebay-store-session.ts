import type { EbayStore, EbayStoreId } from "./ebay-store-routing.js";

/** Evidence is issued by a future exact-target verifier, never inferred from an open tab alone. */
export type EbayBrowserEvidence = Readonly<{
  storeId: EbayStoreId;
  profileId: string;
  accountFingerprint: string;
  endpoint: string;
  browserInstance: string;
  targetId: string;
  url: string;
  verifiedAtEpochMs: number;
  accountIdentityVerified: boolean;
  browserProcessVerified: boolean;
}>;
export type EbaySessionDecision =
  | Readonly<{ ok: true; status: "STORE_SESSION_READY"; storeId: EbayStoreId; targetId: string }>
  | Readonly<{ ok: false; status: "STORE_SESSION_BLOCKED"; reason: string }>;

const HEX_TARGET = /^[A-Fa-f0-9]{32}$/;
const INSTANCE = /^\/devtools\/browser\/[A-Fa-f0-9-]{36}$/;
const MAX_EVIDENCE_AGE_MS = 30_000;

export function verifyEbayStoreSession(
  store: EbayStore,
  evidence: EbayBrowserEvidence | null,
  nowEpochMs: number = Date.now(),
): EbaySessionDecision {
  const blocked = (reason: string): EbaySessionDecision => ({ ok: false, status: "STORE_SESSION_BLOCKED", reason });
  if (store.state !== "READY" || !store.profileId || !store.accountFingerprint) return blocked("AUTH_REQUIRED");
  if (!evidence || !evidence.accountIdentityVerified || !evidence.browserProcessVerified) return blocked("SESSION_ATTESTATION_REQUIRED");
  if (evidence.storeId !== store.id) return blocked("STORE_ID_MISMATCH");
  if (evidence.profileId !== store.profileId || evidence.accountFingerprint !== store.accountFingerprint)
    return blocked("STORE_IDENTITY_MISMATCH");
  if (!Number.isSafeInteger(nowEpochMs) || !Number.isSafeInteger(evidence.verifiedAtEpochMs) ||
      evidence.verifiedAtEpochMs > nowEpochMs || nowEpochMs - evidence.verifiedAtEpochMs > MAX_EVIDENCE_AGE_MS)
    return blocked("SESSION_EVIDENCE_STALE");
  if (!HEX_TARGET.test(evidence.targetId) || !INSTANCE.test(evidence.browserInstance))
    return blocked("BROWSER_TARGET_INVALID");
  try {
    const endpoint = new URL(evidence.endpoint);
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
        endpoint.username || endpoint.password || !endpoint.port || endpoint.pathname !== "/")
      return blocked("CDP_ENDPOINT_NOT_LOOPBACK");
    const url = new URL(evidence.url);
    if (url.protocol !== "https:" || url.hostname !== "www.ebay.com" ||
        url.username || url.password || url.port || url.hash)
      return blocked("EBAY_ORIGIN_INVALID");
  } catch {
    return blocked("SESSION_URL_INVALID");
  }
  return { ok: true, status: "STORE_SESSION_READY", storeId: store.id, targetId: evidence.targetId };
}
