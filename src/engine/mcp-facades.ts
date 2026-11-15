import type { CanonicalToolRegistry, ConsumerToolProjection } from "./canonical-tool-registry.js";

export const CHATGPT_FACADE_GROUPS = ["repo", "runtime", "browser"] as const;

export const LOOPING_OWNED_TOOL_NAMES: readonly string[] = [
  "read_.engine.jev.history.evaluate",
  "write.engine.chat.adopt",
  "read_.engine.event.tail",
  "read_.engine.task.list",
  "read_.engine.task.status",
  "read_.engine.task.handoff",
  "read_.engine.worker.status",
  "write.engine.task.enqueue",
  "write.engine.task.pre_submit.reset",
  "write.engine.worker.tick",
  "write.engine.cycle.step",
  "write.engine.cycle.run",
  "write.engine.cycle.rounds.run",
  "write.engine.cycle.rounds.start",
  "read_.engine.cycle.rounds.status",
  "read_.engine.cycle.rounds.output",
  "write.engine.cycle.rounds.stop",
  "write.engine.chat.bind",
  "write.engine.consumer.bind",
  "write.engine.prompt.draft",
  "write.engine.prompt.submit",
  "write.engine.answer.capture",
  "write.engine.prompt.orphan.resubmit",
  "write.engine.gateway.decide",
  "write.engine.reply.draft",
  "write.engine.reply.submit",
] as const;

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
  // A stable explicit ownership manifest prevents accidental tool creep/overlap.
  // Keep canonical implementations; publish no Browser/Repo/Runtime tools here.
  const loopingRoute = `${base}/looping`;
  if (projections.has(loopingRoute)) throw new Error(`Duplicate MCP facade route: ${loopingRoute}`);
  const engine = registry.forSecondToken("chatgpt", "engine");
  const owned = new Set(LOOPING_OWNED_TOOL_NAMES);
  if (owned.size !== LOOPING_OWNED_TOOL_NAMES.length ||
      engine.toolNames.size !== owned.size ||
      [...engine.toolNames].some((name) => !owned.has(name))) {
    throw new Error("Looping ownership manifest differs from admitted canonical engine tools.");
  }
  for (const [route, projection] of projections) {
    if ([...owned].some((name) => projection.toolNames.has(name))) {
      throw new Error(`Looping tool ownership overlaps facade ${route}`);
    }
  }
  projections.set(loopingRoute, engine);
  return projections;
}
