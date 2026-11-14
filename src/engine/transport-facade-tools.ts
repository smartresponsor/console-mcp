/** Fail-closed transport capability projection. The Console MCP registry remains authoritative. */
export const TRANSPORT_FACADE_TOOL_NAMES = [
  "write.transport.json.artifact",
] as const;

export function transportFacadeToolNames(
  canonicalNames: ReadonlySet<string>,
  admittedChatGptNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const missing = TRANSPORT_FACADE_TOOL_NAMES.filter(
    (name) => !canonicalNames.has(name) || !admittedChatGptNames.has(name),
  );
  if (missing.length > 0) {
    throw new Error(`Transport facade cannot publish unregistered or unadmitted tools: ${missing.join(", ")}`);
  }
  return new Set(TRANSPORT_FACADE_TOOL_NAMES);
}
