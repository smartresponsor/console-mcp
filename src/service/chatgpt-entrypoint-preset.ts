export type ChatGptEntrypointIntent = "repo_rc_implementation" | "general";

export type ChatGptEntrypointPlanInput = {
  rawPrompt: string;
  workspacePath?: string;
  componentName?: string;
  taskPreset?: ChatGptEntrypointIntent | "auto";
  maxAutoIterations?: number;
};

export function buildChatGptEntrypointPlan(input: ChatGptEntrypointPlanInput): Record<string, unknown> {
  const rawPrompt = input.rawPrompt.trim();
  const workspacePath = normalizeOptional(input.workspacePath) ?? inferWorkspacePath(rawPrompt);
  const componentName = normalizeOptional(input.componentName) ?? inferComponentName(rawPrompt, workspacePath);
  const intent = resolveIntent(input.taskPreset ?? "auto", rawPrompt, workspacePath);
  const autoRun = intent === "repo_rc_implementation";
  const maxAutoIterations = clampInt(input.maxAutoIterations ?? 70, 1, 100);
  const enrichedPrompt = autoRun ? buildRepoRcPrompt(rawPrompt, workspacePath, componentName) : rawPrompt;

  return {
    ok: rawPrompt.length > 0,
    status: rawPrompt.length > 0 ? "ENTRYPOINT_PLAN_READY" : "ENTRYPOINT_PLAN_EMPTY_PROMPT",
    intent,
    workspacePath,
    componentName,
    autoRun,
    daemon: {
      runMode: autoRun ? "supervised_daemon" : "off",
      maxAutoIterations: autoRun ? maxAutoIterations : 0,
      phase: "reply_watch",
      taskClass: autoRun ? "repo_rc_implementation" : "normal_answer",
      executePreAsk: autoRun,
      gatewayAskMode: autoRun ? "off" : "blocked_only",
      pollMs: 15000,
      minWaitMs: autoRun ? 3000 : 1000,
      maxWaitMs: 30000,
      stopOnReturnToChat: true,
      stopOnPreAskExecuted: true,
    },
    enrichment: {
      applied: autoRun,
      includesReconnaissance: autoRun,
      includesMemoryGraphRecon: autoRun,
      includesBoundaryGuard: autoRun,
      includesMarketComparison: autoRun,
      includesMilestoneTracks: autoRun,
      includesHelperStack: autoRun,
      includesConsoleRunnerSpecifics: autoRun,
    },
    enrichedPrompt,
  };
}

function buildRepoRcPrompt(rawPrompt: string, workspacePath: string | null, componentName: string | null): string {
  const component = componentName ?? "the target component";
  const workspace = workspacePath ?? "<target workspace>";
  return [
    `Original user request: ${rawPrompt}`,
    "",
    "Resolved orchestration preset: repo_rc_implementation.",
    "",
    "Entrypoint expansion:",
    "- This prompt was expanded by console-mcp from a shorter user request.",
    "- Preserve the original intent while applying the structured execution contract below.",
    "- Do not skip reconnaissance because the original request was short.",
    "",
    "Workspace:",
    workspace,
    "",
    "Target component:",
    component,
    "",
    "Objective:",
    `Perform a deep release-candidate analysis and implementation pass strictly inside the responsibility boundary of ${component}.`,
    "",
    "Boundary rule:",
    `Do not expand ${component} into adjacent bounded contexts. Identify and preserve outside-of-scope areas instead of implementing them here.`,
    "",
    "Required reconnaissance before conclusions or patches:",
    "1. Read repository Markdown and AsciiDoc documentation.",
    "2. Read relevant source, API, architecture documentation, and docblocks.",
    "3. Inspect package manifests, config, source, tests, scripts, CI, policy, and gates.",
    "4. Find any documented memory graph, architecture graph, roadmap graph, or component graph.",
    "5. Use only documented graph update mechanisms; do not invent a new graph format.",
    "6. Identify what belongs to the target component and what is outside its boundary.",
    "7. Compare only in-scope responsibilities against mature product and open-source practices.",
    "",
    "Implementation rules:",
    "- Production-ready changes only.",
    "- No stubs, placeholders, fake tests, or speculative ownership expansion.",
    "- Keep code comments in English.",
    "- Prefer small coherent signed commits.",
    "- Run deterministic gates and report exact changed files, commits, gates, and remaining risks.",
    "- If tooling blocks an action, report the exact blocker and the exact next action.",
    "",
    "Console runner defaults:",
    "- taskClass: repo_rc_implementation.",
    "- phase: reply_watch.",
    "- executePreAsk: true.",
    "- default maxAutoIterations is supplied by the entrypoint plan.",
    "- Do not auto-submit follow-up prompts after the initial confirmed prompt.",
  ].join("\n");
}

function resolveIntent(preset: ChatGptEntrypointIntent | "auto", rawPrompt: string, workspacePath: string | null): ChatGptEntrypointIntent {
  if (preset !== "auto") return preset;
  const repoSignals = Boolean(workspacePath) || /\\/.test(rawPrompt) || /\b(repo|repository|component|bounded context|rc|release candidate)\b/i.test(rawPrompt);
  const implementationSignals = /(доведи|rc|release candidate|реализац|патч|почини|закоммить|глубок|разведк|hardening|implementation|gate)/i.test(rawPrompt);
  return repoSignals && implementationSignals ? "repo_rc_implementation" : "general";
}

function inferWorkspacePath(rawPrompt: string): string | null {
  const match = rawPrompt.match(/[A-Za-z]:\\[^\r\n]+/);
  return match ? match[0].trim() : null;
}

function inferComponentName(rawPrompt: string, workspacePath: string | null): string | null {
  if (/\bCataloging\b/i.test(rawPrompt) || /\\Cataloging\b/i.test(workspacePath ?? "")) return "Cataloging";
  const parts = workspacePath?.split(/[\\/]+/).filter(Boolean) ?? [];
  return parts[parts.length - 1] ?? null;
}


function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}


