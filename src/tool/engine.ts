import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot } from "../service/path.js";
import { bindEngineChatSession, createEnginePaths, enqueueTask, getEngineStatus, getEngineTaskStatus, runWorkerLoop, tailEngineEvent, workerTick } from "../engine/engine-core.js";
import { openChatGptChat } from "./chatgpt-chat-open.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const enqueueSchema = z.object({
  component: z.string().min(1).max(120),
  live: z.boolean().optional(),
}).strict();

const taskStatusSchema = z.object({
  taskId: z.string().min(1).max(200),
}).strict();

const eventTailSchema = z.object({
  taskId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();

const tickSchema = z.object({
  taskId: z.string().min(1).max(200).optional(),
  maxTicks: z.number().int().min(1).max(50).optional(),
  stopOnIdle: z.boolean().optional(),
  stopOnWaitingUser: z.boolean().optional(),
}).strict();

const chatBindSchema = z.object({
  taskId: z.string().min(1).max(200),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  url: z.string().min(1).max(500).default("https://chatgpt.com/"),
  activate: z.boolean().default(true),
  confirmBind: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const emptySchema = z.object({}).strict();

export function registerEngineTools(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.write.engine.task.enqueue", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Enqueue an engine task through the shared CLI-first engine runtime.",
    inputSchema: enqueueSchema,
  }, async ({ component, live }) => textResult(await enqueueTask(enginePathFor(policy, baseDir), component, Boolean(live))));

  server.registerTool("console.read_.engine.task.status", {
    ...buildConsoleToolRegistration(authConfig),
    description: "Read one engine task and its recent event history.",
    inputSchema: taskStatusSchema,
  }, async ({ taskId }) => textResult(await getEngineTaskStatus(enginePathFor(policy, baseDir), taskId)));

  server.registerTool("console.read_.engine.task.list", {
    ...buildConsoleToolRegistration(authConfig),
    description: "Read engine task counts and latest event from the shared runtime.",
    inputSchema: emptySchema,
  }, async () => textResult(await getEngineStatus(enginePathFor(policy, baseDir))));

  server.registerTool("console.read_.engine.event.tail", {
    ...buildConsoleToolRegistration(authConfig),
    description: "Read the engine event log tail, optionally scoped to one task id.",
    inputSchema: eventTailSchema,
  }, async ({ taskId, limit }) => {
    const args = ["event-tail"];
    if (taskId) args.push(taskId);
    if (limit) args.push(`--limit=${limit}`);
    return textResult(await tailEngineEvent(enginePathFor(policy, baseDir), taskId, limit));
  });

  server.registerTool("console.write.engine.worker.tick", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Run exactly one bounded engine worker tick through the shared runtime.",
    inputSchema: tickSchema,
  }, async ({ taskId, maxTicks, stopOnIdle, stopOnWaitingUser }) => {
    const paths = enginePathFor(policy, baseDir);
    if (maxTicks && maxTicks > 1) return textResult(await runWorkerLoop(paths, { maxTicks, stopOnIdle, stopOnWaitingUser }));
    return textResult(await workerTick(paths, taskId));
  });

  server.registerTool("console.write.engine.chat.bind", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Open or reuse a ChatGPT browser document and persist a durable engine task-to-chat binding without drafting or submitting input.",
    inputSchema: chatBindSchema,
  }, async ({ taskId, ports, url, activate, confirmBind, timeoutMs }) => {
    if (!confirmBind) return textResult({ ok: false, status: "CONFIRM_ENGINE_CHAT_BIND_REQUIRED", task_id: taskId, will_open_browser_document: true, will_submit: false });
    const paths = enginePathFor(policy, baseDir);
    const opened = await openChatGptChat(policy, { ports, url, activate, confirmOpen: true, timeoutMs });
    if (opened.ok !== true) return textResult({ ok: false, status: "ENGINE_CHAT_BIND_OPEN_BLOCKED", task_id: taskId, opened });
    return textResult(await bindEngineChatSession(paths, taskId, opened));
  });

  server.registerTool("console.read_.engine.worker.status", {
    ...buildConsoleToolRegistration(authConfig),
    description: "Read current engine worker-facing status from the shared runtime.",
    inputSchema: emptySchema,
  }, async () => textResult(await getEngineStatus(enginePathFor(policy, baseDir))));
}

function enginePathFor(policy: ConsolePolicy, baseDir: string) {
  return createEnginePaths(assertAllowedRoot(path.resolve(baseDir), policy.allowedRoots));
}

