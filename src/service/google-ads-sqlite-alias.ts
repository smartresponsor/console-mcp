/**
 * Optional legacy alias compatibility adapter.
 * Generic SQLite operations do not import or initialize Google Ads Editor services.
 */
export type LegacySqliteAliasResolver = (alias: string) => string | null;

let resolveLegacyAlias: LegacySqliteAliasResolver | null = null;

export function registerLegacyGoogleAdsSqliteAliasResolver(resolver: LegacySqliteAliasResolver): void {
  resolveLegacyAlias = resolver;
}

export function resolveLegacyGoogleAdsSqliteAlias(alias: string): string | null {
  if (!alias.startsWith("google_ads_editor.")) return null;
  if (!resolveLegacyAlias) throw new Error("Google Ads Editor SQLite alias resolver is not registered");
  return resolveLegacyAlias(alias);
}
