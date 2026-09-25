import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeChatGptConversationTarget } from "./browser-session-executor.js";
import { createEnginePaths, recordEngineBrowserTargetClosure } from "../engine/engine-core.js";

export type EngineBrowserTargetReaperOptions = {
  root: string;
  ports?: number[];
  timeoutMs?: number;
  maxClose?: number;
};

export async function reapReadyEngineBrowserTargets(input: EngineBrowserTargetReaperOptions): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const root = path.resolve(input.root);
  const paths = createEnginePaths(root);
  await mkdir(paths.runDir, { recursive: true });
  const lockPath = path.join(paths.runDir, "browser-target-reaper.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
    await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") return { ok: true, status: "ENGINE_BROWSER_TARGET_REAPER_ALREADY_RUNNING", starts_process: false };
    throw error;
  }

  try {
    const maxClose = Math.min(Math.max(input.maxClose ?? 10, 1), 50);
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 3000, 500), 10000);
    const names = await readdir(paths.taskDir).catch(() => []);
    const candidates: Array<{ taskId: string; targetId: string; chatId: string; updatedAt: string | null; reason: "ready_to_delete_recovery_reaper" | "one_shot_answer_recovery_reaper" | "ephemeral_yield_recovery_reaper" }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const task = JSON.parse(await readFile(path.join(paths.taskDir, name), "utf8")) as Record<string, unknown>;
        const standardReady = task.status === "completed" && task.ready_to_delete === true;
        const oneShotReady = task.conversation_policy === "one_shot" && typeof task.answer_captured_at === "string";
        const ephemeralYieldReady = task.browser_target_policy === "ephemeral"
          && typeof task.submitted_at === "string"
          && !["executing", "waiting_assistant"].includes(String(task.status ?? ""));
        if (!standardReady && !oneShotReady && !ephemeralYieldReady) continue;
        if (typeof task.browser_target_closed_at === "string") continue;
        const taskId = stringField(task, "task_id");
        const targetId = stringField(task, "target_id");
        const chatId = stringField(task, "chat_id");
        if (!taskId || !targetId || !chatId) continue;
        const reason = oneShotReady ? "one_shot_answer_recovery_reaper" : (ephemeralYieldReady ? "ephemeral_yield_recovery_reaper" : "ready_to_delete_recovery_reaper");
        candidates.push({ taskId, targetId, chatId, updatedAt: stringField(task, "updated_at"), reason });
      } catch {
        continue;
      }
    }
    candidates.sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")));
    const selected = candidates.slice(0, maxClose);
    const results: Record<string, unknown>[] = [];
    for (const candidate of selected) {
      const close = await closeChatGptConversationTarget({ ports: input.ports, targetId: candidate.targetId, chatId: candidate.chatId, timeoutMs });
      const closed = close.closed === true || close.already_closed === true;
      const status = typeof close.status === "string" ? close.status : "CHATGPT_TARGET_CLOSE_UNKNOWN";
      const recorded = await recordEngineBrowserTargetClosure(paths, candidate.taskId, {
        targetId: candidate.targetId,
        status,
        reason: candidate.reason,
        closed,
        receipt: close,
      });
      results.push({ task_id: candidate.taskId, target_id: candidate.targetId, chat_id: candidate.chatId, closed, status, conversation_deleted: false, recorded });
    }
    const payload = {
      ok: results.every((item) => item.closed === true),
      status: "ENGINE_BROWSER_TARGET_REAPER_COMPLETE",
      at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      candidate_count: candidates.length,
      selected_count: selected.length,
      closed_count: results.filter((item) => item.closed === true).length,
      conversation_delete_count: 0,
      results,
    };
    await writeFile(path.join(paths.runDir, "browser-target-reaper-last.json"), JSON.stringify(payload, null, 2), "utf8");
    return payload;
  } finally {
    await lock?.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" && String(value[key]).trim().length > 0 ? String(value[key]).trim() : null;
}

function nodeErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : null;
}
