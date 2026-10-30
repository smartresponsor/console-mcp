import { normalizePartNumber } from "./ebay-store-routing.js";
export type EbayFormField = Readonly<{ name?: string; labelText?: string; value?: unknown; visible?: boolean; enabled?: boolean }>;
export type FormSpecificResult = Readonly<{ ok: true; mpn: string }> | Readonly<{ ok: false; reason: string }>;
/** Only a visible, enabled, explicitly labeled MPN value can establish MPN evidence. */
export function extractVerifiedMpnFromForm(fields: readonly EbayFormField[]): FormSpecificResult {
  const matches = fields.filter(field => field.visible === true && field.enabled === true && /^MPN$/i.test((field.labelText ?? "").trim()) && !/^search-box-/i.test(field.name ?? ""));
  if (matches.length !== 1) return { ok: false, reason: "VISIBLE_MPN_FIELD_NOT_UNIQUE" };
  const raw = matches[0].value;
  const mpn = typeof raw === "string" ? normalizePartNumber(raw) : null;
  return mpn ? { ok: true, mpn } : { ok: false, reason: "VISIBLE_MPN_VALUE_INVALID" };
}
