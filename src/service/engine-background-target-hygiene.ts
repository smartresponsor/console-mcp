import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEnginePaths } from "../engine/engine-core.js";
import { cleanupIdleBackgroundChatGptTargets } from "./chatgpt-background-target-cleaner.js";

export type EngineBackgroundTargetHygieneOptions = {
  root: string;
  ports?: number[];
  timeoutMs?: number;
  maxClose?: number;
};

const PROTECTED_STATUSES = new Set([
  "executing",
  "waiting_assistant",
  "evaluating",
  "waiting_user",
  "waiting_runtime",
  "dispatch_ready",
]);

export async function runEngineBackgroundTargetHygiene(input: EngineBackgroundTargetHygieneOptions): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const root = path.resolve(input.root);
  const paths = createEnginePaths(root);
  await mkdir(paths.runDir, { recursive: true });
  const lockPath = path.join(paths.runDir, "background-target-hygiene.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
    await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") return { ok: true, status: "ENGINE_BACKGROUND_TARGET_HYGIENE_ALREADY_RUNNING", starts_process: false };
    throw error;
  }

  try {
    const protectedTargetIds = new Set<string>();
    const names = await readdir(paths.taskDir).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const task = JSON.parse(await readFile(path.join(paths.taskDir, name), "utf8")) as Record<string, unknown>;
        if (!PROTECTED_STATUSES.has(String(task.status ?? ""))) continue;
        const targetId = stringField(task, "target_id");
        if (targetId) protectedTargetIds.add(targetId);
      } catch {
        continue;
      }
    }

    const cleanup = await cleanupIdleBackgroundChatGptTargets({
      ports: input.ports,
      timeoutMs: input.timeoutMs,
      maxClose: input.maxClose,
      protectedTargetIds,
    });
    const payload = {
      ok: cleanup.ok === true,
      status: "ENGINE_BACKGROUND_TARGET_HYGIENE_COMPLETE",
      at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      protected_target_count: protectedTargetIds.size,
      cleanup,
    };
    await writeFile(path.join(paths.runDir, "background-target-hygiene-last.json"), JSON.stringify(payload, null, 2), "utf8");
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
