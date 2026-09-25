import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { loadConsolePolicy } from "../Policy/ConsolePolicy.js";
import {
  createEnginePaths,
  recordEngineAnswerCapture,
  recordEngineChatMaterialization,
  recordEngineChatTitlePrefix,
  recordEngineConversationDeletion,
} from "../engine/engine-core.js";
import { closeChatGptConversationTarget, inventoryChatGptTargets } from "./browser-session-executor.js";
import { applyBrowserSessionTitlePrefix, deleteChatGptConversationLifecycle, openChatGptChat } from "../tool/chatgpt-chat-open.js";
import { runChatGptMessageCapture } from "../tool/chatgpt-message-capture.js";

export type EngineConversationLifecycleOptions = {
  root: string;
  ports?: number[];
  timeoutMs?: number;
  maxWork?: number;
};

export async function reapEngineConversationLifecycle(input: EngineConversationLifecycleOptions): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const root = path.resolve(input.root);
  const paths = createEnginePaths(root);
  await mkdir(paths.runDir, { recursive: true });
  const policy = await loadConsolePolicy(process.cwd());
  const lifecyclePolicy = { ...policy, workspaceRoot: paths.workspaceRoot, allowedRoots: [...new Set([...policy.allowedRoots, paths.workspaceRoot])] };
  const ports = input.ports ?? [9223];
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 3000, 500), 10000);
  const maxWork = Math.min(Math.max(input.maxWork ?? 10, 1), 50);
  const inventory = await inventoryChatGptTargets({ ports, timeoutMs }).catch(() => ({ targets: [] }));
  const inventoryTargets = Array.isArray(inventory.targets) ? inventory.targets as Array<Record<string, unknown>> : [];
  const names = await readdir(paths.taskDir).catch(() => []);
  const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const candidates: Array<{ task: Record<string, unknown>; taskId: string; updatedAt: string; deleteReady: boolean; answerRecoveryReady: boolean }> = [];

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const task = JSON.parse(await readFile(path.join(paths.taskDir, name), "utf8")) as Record<string, unknown>;
      const taskId = stringField(task, "task_id");
      if (!taskId) continue;
      const updatedAt = Date.parse(stringField(task, "updated_at") ?? "");
      const recentTask = Number.isFinite(updatedAt) && updatedAt >= recentCutoff;
      const titleMissing = recentTask && typeof task.title_prefixed_at !== "string";
      const deleteReady = task.status === "completed" && task.ready_to_delete === true && typeof task.conversation_deleted_at !== "string";
      const materializationReady = recentTask && !stringField(task, "chat_id") && Boolean(stringField(task, "target_id")) && typeof task.submitted_at === "string";
      const answerRecoveryReady = recentTask && task.conversation_policy !== "one_shot" && typeof task.submitted_at === "string" && typeof task.answer_captured_at !== "string" && Boolean(stringField(task, "chat_id") || stringField(task, "target_id"));
      if (!titleMissing && !deleteReady && !materializationReady && !answerRecoveryReady) continue;
      candidates.push({ task, taskId, updatedAt: stringField(task, "updated_at") ?? "", deleteReady, answerRecoveryReady });
    } catch {
      continue;
    }
  }

  candidates.sort((a, b) => Number(b.deleteReady) - Number(a.deleteReady) || Number(b.answerRecoveryReady) - Number(a.answerRecoveryReady) || b.updatedAt.localeCompare(a.updatedAt));
  const selected = candidates.slice(0, maxWork);
  const results: Record<string, unknown>[] = [];
  for (const candidate of selected) {
    const task = candidate.task;
    let chatId = stringField(task, "chat_id");
    let targetId = stringField(task, "target_id");
    let materialization: Record<string, unknown> | null = null;
    let answerRecovery: Record<string, unknown> | null = null;
    let titleRepair: Record<string, unknown> | null = null;
    let deletion: Record<string, unknown> | null = null;
    let openedTargetId: string | null = null;

    if (!chatId && targetId) {
      const target = inventoryTargets.find((item) => stringField(item, "id") === targetId) ?? null;
      const observedChatId = target ? stringField(target, "chat_id") : null;
      const currentUrl = target ? stringField(target, "url") : null;
      if (observedChatId) {
        materialization = await recordEngineChatMaterialization(paths, candidate.taskId, { chatId: observedChatId, targetId, currentUrl, source: "engine" });
        chatId = observedChatId;
      }
    }


    if (chatId && candidate.answerRecoveryReady) {
      const captureInput = () => ({
        ports,
        preferredChatId: chatId!,
        expectedTargetId: targetId ?? undefined,
        expectedTaskId: candidate.taskId,
        requireChatId: true,
        maxMessages: 30,
        timeoutMs,
      });
      let capture = await runChatGptMessageCapture(captureInput()).catch((error) => ({ ok: false, status: "MESSAGE_CAPTURE_EXCEPTION", error: error instanceof Error ? error.message : String(error), latest_assistant: null }));
      if (capture.ok !== true) {
        const opened = await openChatGptChat(lifecyclePolicy, { ports, url: `https://chatgpt.com/c/${encodeURIComponent(chatId)}`, activate: false, confirmOpen: true, timeoutMs }, { forceNewTarget: false }).catch((error) => ({ ok: false, status: "CHAT_OPEN_FAILED", error: error instanceof Error ? error.message : String(error) }));
        const selectedTarget = objectField(opened, "selected");
        openedTargetId = selectedTarget ? stringField(selectedTarget, "id") : openedTargetId;
        targetId = openedTargetId ?? targetId;
        if (opened.ok === true) capture = await runChatGptMessageCapture(captureInput()).catch((error) => ({ ok: false, status: "MESSAGE_CAPTURE_EXCEPTION", error: error instanceof Error ? error.message : String(error), latest_assistant: null }));
      }
      const latestAssistant = objectField(capture, "latest_assistant");
      const assistantText = latestAssistant ? stringField(latestAssistant, "text") : null;
      const assistantHash = latestAssistant ? stringField(latestAssistant, "hash") : null;
      const baselineHash = stringField(task, "baseline_assistant_hash");
      const readySignal = assistantText ? parseReadyToDeleteProtocolLine(assistantText) : null;
      const isNewAssistant = Boolean(assistantHash && (!baselineHash || assistantHash !== baselineHash));
      if (capture.ok === true && readySignal !== null && isNewAssistant) {
        const recorded = await recordEngineAnswerCapture(paths, candidate.taskId, capture);
        answerRecovery = { ok: recorded.ok === true, status: "ENGINE_ANSWER_RECOVERED_FROM_PROTOCOL_LINE", ready_to_delete: readySignal, recorded, capture_status: capture.status ?? null };
      } else {
        answerRecovery = { ok: false, status: "ENGINE_ANSWER_RECOVERY_NOT_READY", ready_to_delete: readySignal, assistant_hash: assistantHash, baseline_assistant_hash: baselineHash, capture_status: capture.status ?? null };
      }
    }

    if (chatId && typeof task.title_prefixed_at !== "string") {
      const workspacePath = stringField(task, "workspace_path");
      if (workspacePath) {
        const relativeWorkspace = path.relative(paths.workspaceRoot, path.resolve(workspacePath));
        const workspaceAllowed = relativeWorkspace === "" || (!relativeWorkspace.startsWith(".." + path.sep) && relativeWorkspace !== ".." && !path.isAbsolute(relativeWorkspace));
        if (!workspaceAllowed) {
          titleRepair = { ok: false, title_prefix: { ok: false, status: "ENGINE_TITLE_WORKSPACE_OUTSIDE_ENGINE_ROOT", workspace_path: workspacePath } };
        } else {
        const applyTitle = async () => await applyBrowserSessionTitlePrefix(lifecyclePolicy, {
          ports, expectedChatId: chatId!, workspacePath, chatTitleMode: "auto", waitForChatId: false, confirmTitlePrefix: true, timeoutMs,
        }).catch((error) => ({ ok: false, status: "ENGINE_CHAT_TITLE_PREFIX_EXCEPTION", error: error instanceof Error ? error.message : String(error) }));
        let title = await applyTitle();
        const titleLastResult = objectField(title, "last_result");
        const titleTargetMissing = String(title.status ?? "").includes("TARGET_NOT_FOUND") || String(titleLastResult?.status ?? "").includes("TARGET_NOT_FOUND");
        if (title.ok !== true && titleTargetMissing) {
          const opened = await openChatGptChat(policy, { ports, url: `https://chatgpt.com/c/${encodeURIComponent(chatId)}`, activate: false, confirmOpen: true, timeoutMs }, { forceNewTarget: false }).catch((error) => ({ ok: false, status: "CHAT_OPEN_FAILED", error: error instanceof Error ? error.message : String(error) }));
          const selectedTarget = objectField(opened, "selected");
          openedTargetId = selectedTarget ? stringField(selectedTarget, "id") : null;
          targetId = openedTargetId ?? targetId;
          if (opened.ok === true) title = await applyTitle();
        }
        if (title.ok === true) {
          const recorded = await recordEngineChatTitlePrefix(paths, candidate.taskId, title);
          titleRepair = { ok: recorded.ok === true, title_prefix: title, recorded };
        } else {
          titleRepair = { ok: false, title_prefix: title };
        }
      }
    }
    }

    const deleteReady = task.status === "completed" && task.ready_to_delete === true && typeof task.conversation_deleted_at !== "string";
    if (chatId && deleteReady) {
      const deleted = await deleteChatGptConversationLifecycle({ ports, expectedChatId: chatId, readyToDelete: true, timeoutMs });
      const status = stringField(deleted, "status") ?? "CHATGPT_CHAT_DELETE_UNKNOWN";
      const recorded = await recordEngineConversationDeletion(paths, candidate.taskId, { status, deleted: deleted.ok === true, receipt: deleted });
      deletion = { ...deleted, recorded };
    }

    if (chatId && openedTargetId) {
      await closeChatGptConversationTarget({ ports, targetId: openedTargetId, chatId, timeoutMs }).catch(() => undefined);
    }

    results.push({ task_id: candidate.taskId, chat_id: chatId, target_id: targetId, materialization, answer_recovery: answerRecovery, title_repair: titleRepair, deletion });
  }

  return {
    ok: true,
    status: "ENGINE_CONVERSATION_LIFECYCLE_REAPER_COMPLETE",
    at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    candidate_count: candidates.length,
    selected_count: selected.length,
    materialized_count: results.filter((item) => objectField(item, "materialization")?.ok === true).length,
    answer_recovered_count: results.filter((item) => objectField(item, "answer_recovery")?.ok === true).length,
    title_repaired_count: results.filter((item) => objectField(item, "title_repair")?.ok === true).length,
    conversation_deleted_count: results.filter((item) => objectField(item, "deletion")?.ok === true).length,
    results,
  };
}


function parseReadyToDeleteProtocolLine(text: string): boolean | null {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) return null;
  try {
    const parsed = JSON.parse(last) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    return keys.length === 1 && typeof parsed.ready_to_delete === "boolean" ? parsed.ready_to_delete : null;
  } catch {
    return null;
  }
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" && String(value[key]).trim().length > 0 ? String(value[key]).trim() : null;
}
function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return typeof value[key] === "object" && value[key] !== null ? value[key] as Record<string, unknown> : null;
}
