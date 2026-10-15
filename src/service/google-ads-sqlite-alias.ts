import { listGoogleAdsEditorDatabases } from "./google-ads-editor.js";

/** Compatibility bridge for legacy Google Ads Editor SQLite aliases. */
export function resolveLegacyGoogleAdsSqliteAlias(alias: string): string | null {
  if (!alias.startsWith("google_ads_editor.")) return null;
  const database = listGoogleAdsEditorDatabases().databases.find((item) => item.alias === alias);
  if (!database) throw new Error(`Unknown Google Ads Editor database alias: ${alias}`);
  return database.path;
}
