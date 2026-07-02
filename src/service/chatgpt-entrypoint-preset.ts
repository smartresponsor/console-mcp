export type ChatGptEntrypointIntent = "repo_rc_implementation" | "general";

export type ChatGptEntrypointPlanInput = {
  rawPrompt: string;
  workspacePath?: string;
  componentName?: string;
  taskPreset?: ChatGptEntrypointIntent | "auto";
  maxAutoIterations?: number;
};

export function buildChatGptEntrypointPlan(input: ChatGptEntrypointPlanInput): Record<string, unknown> {
  // Out-of-scope scratch file kept unregistered; do not include in rename-flow commits.
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
    "Работаем в локальном репозитории:",
    "",
    workspace,
    "",
    `Задача: глубокий RC-анализ и реализация строго в границах ответственности ${component}.`,
    "",
    `Очень важно: не расширяй ответственность ${component} в Product, Order, Inventory, Billing, UI, Platform или другие bounded contexts. Все выводы, сравнения и изменения должны оставаться внутри ответственности ${component}.`,
    "",
    "Перед выводами и перед патчами выполни разведку:",
    "",
    "1. Прочитай все *.md.",
    "2. Прочитай все *.adoc.",
    "3. Прочитай PHP docblock / API / architecture documentation в src, tests, tool, docs, config, если она есть.",
    "4. Найди memory graph / persistent memory / architecture graph / roadmap graph / component graph, если он есть.",
    "5. Если в репозитории есть documented/canonical механизм обновления memory graph, безопасно используй его или предложи точную команду. Не придумывай новый формат memory graph без подтверждения.",
    "6. Прочитай composer.json, composer.lock summary, config, src, tests, tool/scripts, CI/policy/gates.",
    `7. Определи boundary ${component}: какие сущности, сервисы, API, storage, events, docs and tests реально относятся к ${component}, а что должно оставаться outside-of-scope.`,
    `8. Сравни ${component} только в рамках его ответственности с топ-линейкой рынка и зрелыми open-source/product practices. Сравнение должно быть практическим: taxonomy/catalog modeling, classification, attributes, category lifecycle, validation, search/index readiness, governance, API boundaries, migration safety, logging, exceptions, tests, docs, RC gates. Не уходи в product/order/inventory features.`,
    "9. Сформируй два milestone-трека:",
    "",
    "Track A — hardening/fix:",
    "- bugs",
    "- fragile places",
    "- weak logging",
    "- weak exception handling",
    "- missing tests",
    "- missing docs",
    "- unclear boundaries",
    "- inconsistent naming",
    "- weak RC gates",
    "- memory graph/documentation drift",
    "- architectural drift",
    "",
    "Track B — growth:",
    "- capability gaps",
    "- market-parity improvements",
    "- operational maturity",
    "- observability",
    "- future-safe extension points",
    "- API/contract clarity",
    "- migration/read-model/index readiness strictly inside this bounded context",
    "",
    "10. Как helper-stack прочитай Objecting, Cruding, Viewing, Interfacing, если эти sibling/helper repositories доступны в workspace. Используй их только как канонические helpers/stack context, не расширяй ответственность целевого компонента.",
    "",
    "Console-mcp runner specifics:",
    "- Use supervised automatic multi-iteration run-loop by default for this repo RC task.",
    "- Default maxAutoIterations: 70.",
    "- phase: reply_watch.",
    "- taskClass: repo_rc_implementation.",
    "- executePreAsk: true.",
    "- gatewayAskMode: off unless a deterministic blocker requires advisory review.",
    "- The daemon may watch, probe, summarize, run deterministic gates, and prepare pre-ASK material.",
    "- Do not submit additional prompts automatically after the initial confirmed prompt.",
    "- Timing must be normalized as a system; do not hard-fail only because maxElapsedMs is lower than the required maxAutoIterations/poll budget.",
    "",
    "После анализа начинай реализацию.",
    "",
    "Implementation rules:",
    "- Production-ready only.",
    "- No stubs.",
    "- No TODO placeholders.",
    "- No fake tests.",
    "- Keep comments in English only.",
    "- Keep repo clean.",
    "- Prefer coherent signed commits.",
    "- Run deterministic gates.",
    "- Report exact changed files, commits, gates, and remaining risks.",
    "- If something is blocked by tooling, explain exact blocker and provide exact command or next action.",
    `- Do not broaden scope outside ${component}.`,
    "- Do not ask for confirmation unless a destructive action is required.",
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


