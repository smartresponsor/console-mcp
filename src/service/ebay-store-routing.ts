/**
 * Seller-account-neutral routing for Nellis and direct-input eBay draft jobs.
 * No browser processes, cookies, tokens or login state are accessed here.
 */
export type EbayStoreId = "parts" | "toner" | "general";
export type EbaySource = "nellis" | "direct";
export type EbayCategory = "appliance-part" | "toner" | "other";
export type EbayStoreState = "UNCONFIGURED" | "AUTH_REQUIRED" | "READY";
export type EbayStore = Readonly<{
  id: EbayStoreId;
  category: EbayCategory;
  state: EbayStoreState;
  profileId: string | null;
  accountFingerprint: string | null;
}>;
export type EbayDraftInput = Readonly<{
  source: EbaySource;
  title: string;
  category: EbayCategory;
  mpn: string | null;
  inventoryNumber: string | null;
  storeId?: EbayStoreId;
  pickedUp?: boolean;
  condition?: "New" | "Used" | "Unknown";
}>;
export type EbayDraftDecision =
  | Readonly<{ ok: true; status: "READY_FOR_DRAFT"; storeId: EbayStoreId; mpn: string; idempotencyKey: string }>
  | Readonly<{ ok: false; status: "BLOCKED"; reason: string; storeId?: EbayStoreId }>;

const defaultStores: Readonly<Record<EbayStoreId, EbayStore>> = Object.freeze({
  parts: Object.freeze({ id: "parts", category: "appliance-part", state: "AUTH_REQUIRED", profileId: null, accountFingerprint: null }),
  toner: Object.freeze({ id: "toner", category: "toner", state: "UNCONFIGURED", profileId: null, accountFingerprint: null }),
  general: Object.freeze({ id: "general", category: "other", state: "UNCONFIGURED", profileId: null, accountFingerprint: null }),
});

export function initialEbayStoreRegistry(): Readonly<Record<EbayStoreId, EbayStore>> {
  return defaultStores;
}

export function normalizePartNumber(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const part = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._/-]{2,63}$/.test(part)) return null;
  return part;
}

export function validateEbayStoreRegistry(stores: Readonly<Record<EbayStoreId, EbayStore>>): string[] {
  const problems: string[] = [];
  const profiles = new Set<string>();
  const accounts = new Set<string>();
  for (const id of ["parts", "toner", "general"] as const) {
    const store = stores[id];
    if (!store || store.id !== id) { problems.push("STORE_ID_MISMATCH:" + id); continue; }
    if (store.state === "READY" && (!store.profileId || !store.accountFingerprint)) problems.push("STORE_AUTH_UNVERIFIED:" + id);
    if (store.profileId) {
      if (profiles.has(store.profileId)) problems.push("STORE_PROFILE_REUSED:" + id);
      profiles.add(store.profileId);
    }
    if (store.accountFingerprint) {
      if (accounts.has(store.accountFingerprint)) problems.push("STORE_ACCOUNT_REUSED:" + id);
      accounts.add(store.accountFingerprint);
    }
  }
  return problems;
}

export function routeEbayDraft(
  input: EbayDraftInput,
  stores: Readonly<Record<EbayStoreId, EbayStore>> = defaultStores,
  seenKeys: ReadonlySet<string> = new Set<string>(),
): EbayDraftDecision {
  const issue = validateEbayStoreRegistry(stores)[0];
  if (issue) return { ok: false, status: "BLOCKED", reason: issue };
  if (!input.title.trim()) return { ok: false, status: "BLOCKED", reason: "TITLE_REQUIRED" };
  const mpn = normalizePartNumber(input.mpn);
  if (!mpn) return { ok: false, status: "BLOCKED", reason: "MPN_REQUIRED_OR_AMBIGUOUS" };
  if (input.source === "nellis") {
    if (!input.pickedUp) return { ok: false, status: "BLOCKED", reason: "NELLIS_PICKED_UP_REQUIRED" };
    if (!/^\d{7,}$/.test(input.inventoryNumber ?? "")) return { ok: false, status: "BLOCKED", reason: "NELLIS_INVENTORY_REQUIRED" };
  } else if (input.inventoryNumber) {
    return { ok: false, status: "BLOCKED", reason: "DIRECT_INPUT_CANNOT_ASSERT_NELLIS_INVENTORY" };
  }
  if (input.condition !== "New") return { ok: false, status: "BLOCKED", reason: "NEW_CONDITION_NOT_VERIFIED" };
  const route: Readonly<Record<EbayCategory, EbayStoreId>> = { "appliance-part": "parts", toner: "toner", other: "general" };
  const storeId = input.storeId ?? route[input.category];
  const store = stores[storeId];
  if (!store || store.category !== input.category) return { ok: false, status: "BLOCKED", reason: "STORE_CATEGORY_MISMATCH", storeId };
  if (store.state !== "READY" || !store.profileId || !store.accountFingerprint)
    return { ok: false, status: "BLOCKED", reason: "AUTH_REQUIRED", storeId };
  const idempotencyKey = input.source === "nellis"
    ? "nellis:" + input.inventoryNumber + ":" + storeId
    : "direct:" + storeId + ":" + mpn;
  if (seenKeys.has(idempotencyKey)) return { ok: false, status: "BLOCKED", reason: "DUPLICATE_JOB", storeId };
  return { ok: true, status: "READY_FOR_DRAFT", storeId, mpn, idempotencyKey };
}
