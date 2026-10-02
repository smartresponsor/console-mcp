import { getEngineTaskStatus, type EnginePaths } from "./engine-core.js";

export type EngineCycleStage =
  | "chat_bind"
  | "composer_preflight"
  | "prompt_draft"
  | "prompt_submit"
  | "answer_capture"
  | "title_prefix"
  | "gateway_decision"
  | "reply_draft"
  | "reply_submit"
  | "complete";

export type EngineCycleStepOptions = {
  taskId: string;
  mode?: "plan" | "execute";
};

export type EngineCycleContext = {
  paths: EnginePaths;
  taskId: string;
  task: Record<string, unknown>;
  events: Record<string, unknown>[];
};

export type EngineCycleExecutor = {
  executeStage(stage: EngineCycleStage, context: EngineCycleContext): Promise<Record<string, unknown>>;
};

export async function runEngineCycleStep(paths: EnginePaths, options: EngineCycleStepOptions, executor?: EngineCycleExecutor): Promise<Record<string, unknown>> {
  const mode = options.mode ?? "plan";
  const status = await getEngineTaskStatus(paths, options.taskId);
  if (status.ok !== true) return status;
  const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
  const events = Array.isArray(status.events) ? status.events as Record<string, unknown>[] : [];
  const stage = detectEngineCycleStage(task);
  const nextAction = nextActionForStage(stage);

  if (mode !== "execute") {
    return {
      ok: true,
      status: "ENGINE_CYCLE_STEP_PLANNED",
      task_id: options.taskId,
      stage,
      next_action: nextAction,
      local_cli: true,
      executed: false,
    };
  }

  if (executor) {
    const executed = await executor.executeStage(stage, { paths, taskId: options.taskId, task, events });
    return {
      ok: executed.ok === true,
      status: executed.status ?? "ENGINE_CYCLE_STAGE_EXECUTED",
      task_id: options.taskId,
      stage,
      next_action: executed.next_action ?? nextAction,
      local_cli: true,
      executed: executed.ok === true,
      result: executed,
    };
  }

  if (stage === "complete") {
    return {
      ok: true,
      status: "ENGINE_CYCLE_COMPLETE",
      task_id: options.taskId,
      stage,
      next_action: nextAction,
      local_cli: true,
      executed: false,
    };
  }

  return {
    ok: false,
    status: "ENGINE_CYCLE_BROWSER_STAGE_REQUIRED",
    task_id: options.taskId,
    stage,
    next_action: nextAction,
    local_cli: true,
    executed: false,
    reason: "browser executor extraction is the next implementation step",
  };
}

export function detectEngineCycleStage(task: Record<string, unknown>): EngineCycleStage {
  const hasTarget = typeof task.target_id === "string";

  if (typeof task.assistant_hash === "string" && typeof task.assistant_length === "number") {
    if (typeof task.title_prefixed_at !== "string") return hasTarget ? "title_prefix" : "chat_bind";
    if (typeof task.decision_status !== "string") return "gateway_decision";
    if (typeof task.reply_back_hash !== "string" || typeof task.reply_back_length !== "number") return hasTarget ? "reply_draft" : "chat_bind";
    if (typeof task.reply_back_sent_at !== "string") return hasTarget ? "reply_submit" : "chat_bind";
    return "complete";
  }

  if (typeof task.submitted_at === "string") return hasTarget ? "answer_capture" : "chat_bind";
  if (!hasTarget) return "chat_bind";
  if (typeof task.composer_ready_at !== "string" || task.composer_preflight_target_id !== task.target_id) return "composer_preflight";
  if (typeof task.draft_hash !== "string" || typeof task.draft_length !== "number") return "prompt_draft";
  return "prompt_submit";
}

function nextActionForStage(stage: EngineCycleStage): string {
  switch (stage) {
    case "chat_bind": return "bind regular ChatGPT target";
    case "composer_preflight": return "wait for stable composer readiness";
    case "prompt_draft": return "draft phase prompt";
    case "prompt_submit": return "submit phase prompt";
    case "answer_capture": return "capture assistant answer and materialized chat id";
    case "title_prefix": return "apply durable component title prefix";
    case "gateway_decision": return "record gateway decision";
    case "reply_draft": return "draft reply-back";
    case "reply_submit": return "submit reply-back";
    case "complete": return "no missing cycle stage";
  }
}
