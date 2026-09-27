import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createEnginePaths, recordEngineExecutionOutcome } from "../engine/engine-core.js";

export type DeletedAnswerCaptureTask = Record<string, unknown>;

export function classifyIrrecoverableDeletedAnswerCaptureTask(task: DeletedAnswerCaptureTask): { terminal: boolean; reason: string | null } {
  const terminal = task.status === "waiting_runtime"
    && task.execution_blocked_stage === "answer_capture"
    && typeof task.conversation_deleted_at === "string"
    && typeof task.answer_captured_at !== "string";
  return {
    terminal,
    reason: terminal ? "CONVERSATION_DELETED_BEFORE_ANSWER_CAPTURE" : null,
  };
}

export async function reconcileIrrecoverableDeletedAnswerCaptureTasks(input: { root: string; maxWork?: number }): Promise<Record<string, unknown>> {
  const root = path.resolve(input.root);
  const paths = createEnginePaths(root);
  await mkdir(paths.runDir, { recursive: true });
  const maxWork = Math.min(Math.max(input.maxWork ?? 20, 1), 100);
  const names = await readdir(paths.taskDir).catch(() => []);
  const candidates: Array<{ taskId: string; task: Record<string, unknown> }> = [];

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const task = JSON.parse(await readFile(path.join(paths.taskDir, name), "utf8")) as Record<string, unknown>;
      const classification = classifyIrrecoverableDeletedAnswerCaptureTask(task);
      const taskId = stringField(task, "task_id");
      if (classification.terminal && taskId) candidates.push({ taskId, task });
    } catch {
      continue;
    }
  }

  candidates.sort((a, b) => String(a.task.updated_at ?? "").localeCompare(String(b.task.updated_at ?? "")));
  const selected = candidates.slice(0, maxWork);
  const results: Record<string, unknown>[] = [];
  for (const candidate of selected) {
    const receipt = {
      conversation_deleted_at: candidate.task.conversation_deleted_at ?? null,
      conversation_delete_status: candidate.task.conversation_delete_status ?? null,
      previous_status: candidate.task.status ?? null,
      previous_stage: candidate.task.execution_blocked_stage ?? null,
      previous_reason: candidate.task.execution_blocked_reason ?? null,
      answer_captured_at: candidate.task.answer_captured_at ?? null,
      submitted_at: candidate.task.submitted_at ?? null,
      chat_id: candidate.task.chat_id ?? null,
    };
    const recorded = await recordEngineExecutionOutcome(paths, candidate.taskId, {
      status: "failed",
      stage: "answer_capture",
      reason: "CONVERSATION_DELETED_BEFORE_ANSWER_CAPTURE",
      nextAction: "terminal: conversation was deleted before a durable assistant answer was captured",
      receipt,
    });
    results.push({ task_id: candidate.taskId, recorded });
  }

  return {
    ok: results.every((item) => (item.recorded as Record<string, unknown>)?.ok === true),
    status: "ENGINE_DELETED_ANSWER_RECONCILIATION_COMPLETE",
    candidate_count: candidates.length,
    reconciled_count: results.length,
    max_work: maxWork,
    results,
  };
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" && String(value[key]).trim().length > 0 ? String(value[key]).trim() : null;
}
