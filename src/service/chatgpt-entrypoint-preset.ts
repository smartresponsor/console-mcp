import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_RC_PROMPT_TEMPLATE_RELATIVE_PATH = "prompt/chatgpt/repo-rc-implementation.md";
const REPO_RC_ADOPT_PROMPT_TEMPLATE_RELATIVE_PATH = "prompt/chatgpt/repo-rc-adopt-continuation.md";
const REQUIRED_TEMPLATE_MARKERS: Record<"go" | "adopt", readonly string[]> = {
  go: ["{{workspacePath}}", "{{componentName}}"],
  adopt: [],
};

export type ChatGptEntrypointIntent = "repo_rc_implementation" | "general";

export type ChatGptEntrypointPlanInput = {
  rawPrompt: string;
  workspacePath?: string;
  componentName?: string;
  taskPreset?: ChatGptEntrypointIntent | "auto";
  maxAutoIterations?: number;
  executionMode?: "go" | "adopt";
  executionAuthority?: "READ_ONLY" | "WRITE_ALLOWED";
};

export function buildChatGptEntrypointPlan(input: ChatGptEntrypointPlanInput): Record<string, unknown> {
  const rawPrompt = input.rawPrompt.trim();
  const workspacePath = normalizeOptional(input.workspacePath) ?? inferWorkspacePath(rawPrompt);
  const componentName = normalizeOptional(input.componentName) ?? inferComponentName(rawPrompt, workspacePath);
  const intent = resolveIntent(input.taskPreset ?? "auto", rawPrompt, workspacePath);
  const autoRun = intent === "repo_rc_implementation";
  const maxAutoIterations = clampInt(input.maxAutoIterations ?? 5, 5, 100);
  const executionMode = input.executionMode ?? "go";
  const executionAuthority = input.executionAuthority ?? detectEntrypointExecutionAuthority(rawPrompt);
  const enrichedPrompt = autoRun ? buildRepoRcPrompt(rawPrompt, workspacePath, componentName, executionMode, executionAuthority) : stripExecutorControlSyntax(rawPrompt);

  return {
    ok: rawPrompt.length > 0,
    status: rawPrompt.length > 0 ? "ENTRYPOINT_PLAN_READY" : "ENTRYPOINT_PLAN_EMPTY_PROMPT",
    intent,
    executionMode,
    workspacePath,
    componentName,
    autoRun,
    executionAuthority,
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

function buildRepoRcPrompt(rawPrompt: string, workspacePath: string | null, componentName: string | null, executionMode: "go" | "adopt", executionAuthority: "READ_ONLY" | "WRITE_ALLOWED"): string {
  const component = componentName ?? "the target component";
  const workspace = workspacePath ?? "<target workspace>";
  const sanitizedPrompt = stripExecutorControlSyntax(rawPrompt);
  const rendered = renderPromptTemplate(loadRepoRcPromptTemplate(executionMode), {
    rawPrompt: sanitizedPrompt,
    workspacePath: workspace,
    componentName: component,
  });
  if (executionAuthority !== "READ_ONLY") return rendered;
  return [
    "Execution authority: READ_ONLY.",
    "This authority overrides any generic implementation, patching, commit, cleanup, or repair wording elsewhere in this template.",
    "Do not modify, stage, commit, reset, clean, delete, rename, or generate repository files. Use read-only inspection and verification only.",
    "If a defect is found, report it as a finding and continue only with safe read-only diagnostics.",
    "",
    rendered,
  ].join("\n");
}

export function stripExecutorControlSyntax(rawPrompt: string): string {
  return rawPrompt
    .replace(/^\s*(?:Cmcp\s+go|Adopt\s+go)\s+/iu, "")
    .replace(/(?:^|\s)M\d+(?:[.,;:!?])?(?=\s|$)/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function detectEntrypointExecutionAuthority(rawPrompt: string): "READ_ONLY" | "WRITE_ALLOWED" {
  const normalized = rawPrompt.replace(/\s+/g, " ").trim();
  const explicitGlobalReadOnly = /\b(?:execution\s+authority\s*:\s*read[- _]only|read[- ]only\s+(?:task|run|execution)|verification\s+only)\b/i.test(normalized)
    || /\b(?:no\s+repository\s+(?:changes|modifications)|do\s+not\s+(?:modify|edit|write|change)\s+(?:the\s+)?(?:target\s+)?repository)\b/i.test(normalized)
    || /\b(?:только\s+провер(?:ка|ить)|не\s+изменя(?:й|ть)\s+(?:целевой\s+)?репозиторий|только\s+read[- ]only)\b/iu.test(normalized);
  if (explicitGlobalReadOnly) return "READ_ONLY";
  const explicitWriteIntent = /\b(?:implement|fix|repair|refactor|rename|move|canonicali[sz]e|bring\s+.{0,80}\b(?:canonical|clean|green)|update\s+files|modify\s+the\s+target)\b/i.test(normalized)
    || /\b(?:исправ(?:ь|ить)|почини(?:ть)?|переимену(?:й|ть)|перенес(?:и|ти)|привести\s+.{0,100}\b(?:канонич|чист)|довести\s+.{0,100}\b(?:состояни|зел[её]н)|измен(?:и|ить)\s+целевой)\b/iu.test(normalized);
  if (explicitWriteIntent) return "WRITE_ALLOWED";
  if (/^\s*(?:read[- ]only|verification\s+only)\b/i.test(normalized)) return "READ_ONLY";
  if (/\bdo\s+not\b.{0,100}\b(?:modify|edit|write|change)\b/i.test(normalized) && !/\b(?:reference|sibling|other|canon(?:ization|isating)?)\b/i.test(normalized)) return "READ_ONLY";
  if (/\b(?:не\s+изменя(?:й|ть)|не\s+редактиру(?:й|ть))\b/iu.test(normalized) && !/\b(?:этот\s+справочн|соседн|друг(?:ой|ие)|canon(?:ization|isating)?)\b/iu.test(normalized)) return "READ_ONLY";
  return "WRITE_ALLOWED";
}

function loadRepoRcPromptTemplate(executionMode: "go" | "adopt"): string {
  const templatePath = executionMode === "adopt"
    ? REPO_RC_ADOPT_PROMPT_TEMPLATE_RELATIVE_PATH
    : REPO_RC_PROMPT_TEMPLATE_RELATIVE_PATH;
  const template = readFileSync(join(process.cwd(), templatePath), "utf8").trimEnd();
  validateTemplateMarkers(template, executionMode, templatePath);
  return template;
}

function validateTemplateMarkers(template: string, executionMode: "go" | "adopt", templatePath: string): void {
  const missingMarkers = REQUIRED_TEMPLATE_MARKERS[executionMode].filter((marker) => !template.includes(marker));
  if (missingMarkers.length > 0) {
    throw new Error(`ChatGPT ${executionMode} template '${templatePath}' is missing required markers: ${missingMarkers.join(", ")}.`);
  }
}

function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (rendered, [key, value]) => rendered.replaceAll(`{{${key}}}`, value),
    template,
  );
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


