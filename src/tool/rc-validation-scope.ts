/** Select only commands admitted by the requested RC validation scope. */
export type RcValidationProfile = "auto" | "symfony_host" | "node_package" | "mixed";
export type RcValidationFamily = "composer" | "npm";
export type RcValidationSelection = { run: boolean; externalAuthenticationRequired: boolean };
const externalAuthenticationSmoke = /^smoke:(?:local-(?:codex|chatgpt)|oauth|public)$/i;
export const isRcExternalAuthenticationScript = (script: string): boolean => externalAuthenticationSmoke.test(script);
export function selectRcValidationScript(
  profile: RcValidationProfile, family: RcValidationFamily, script: string,
): RcValidationSelection {
  if (profile === "symfony_host" && family !== "composer") return { run: false, externalAuthenticationRequired: false };
  if (profile === "node_package" && family !== "npm") return { run: false, externalAuthenticationRequired: false };
  if (profile === "node_package" && externalAuthenticationSmoke.test(script)) {
    return { run: false, externalAuthenticationRequired: true };
  }
  return { run: true, externalAuthenticationRequired: false };
}

/** Full RC cannot be green when the selected code-only scope omits a live authentication gate. */
export function rcExternalAuthenticationBlocker(
  mode: "diagnose" | "validate" | "plan" | "repair" | "full",
  profile: RcValidationProfile,
  required: readonly string[],
): string | null {
  void profile;
  return mode === "full" && required.length > 0
    ? "external_authentication_not_validated"
    : null;
}
