import type { CanonicalToolRegistry, ConsumerToolProjection } from "./canonical-tool-registry.js";

/**
 * ChatGPT Network tools have exactly one owning endpoint: /mcp/network.
 * Never return any read_.network.* declaration to the primary ChatGPT /mcp
 * projection, even when the network transport is disabled or being configured.
 *
 * The canonical descriptors/handlers are unaffected; Codex and runner remain
 * independent consumers of the same registry.
 */
export function buildExclusiveNetworkProjections(
  registry: CanonicalToolRegistry,
  facadeEnabled: boolean,
): { main: ConsumerToolProjection; facade: ConsumerToolProjection | undefined } {
  const owned = registry.descriptors.filter((descriptor) =>
    descriptor.consumers.chatgpt && /^(?:read_|write)\.network\./.test(descriptor.name));
  if (owned.some((descriptor) => !descriptor.name.startsWith("read_.network."))) {
    throw new Error("Network facade refuses mutating write tools");
  }
  if (owned.length === 0) {
    throw new Error("Network facade ownership manifest has no admitted tools");
  }
  const names = new Set(owned.map((descriptor) => descriptor.name));
  const main = registry.forConsumerExcluding("chatgpt", names);
  if ([...names].some((name) => main.toolNames.has(name))) {
    throw new Error("Network tools leaked into main ChatGPT projection");
  }
  const facade = facadeEnabled ? registry.forSecondToken("chatgpt", "network") : undefined;
  if (facade && (facade.toolCount !== names.size ||
      [...facade.toolNames].some((name) => !names.has(name)))) {
    throw new Error("Network facade projection differs from canonical ownership");
  }
  return { main, facade };
}
