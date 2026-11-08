import type { CanonicalToolRegistry, ConsumerToolProjection } from "./canonical-tool-registry.js";

export const CHATGPT_FACADE_GROUPS = ["repo", "runtime", "browser", "database", "window", "archive", "transport", "network"] as const;

export function buildChatGptFacadeProjections(
  registry: CanonicalToolRegistry,
  endpoint: string,
): ReadonlyMap<string, ConsumerToolProjection> {
  const base = endpoint.replace(/\/$/, "");
  const projections = new Map<string, ConsumerToolProjection>();
  for (const group of CHATGPT_FACADE_GROUPS) {
    const route = `${base}/${group}`;
    if (projections.has(route)) throw new Error(`Duplicate MCP facade route: ${route}`);
    projections.set(route, registry.forSecondToken("chatgpt", group));
  }
  return projections;
}
