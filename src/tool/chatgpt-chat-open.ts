import { request } from "node:http";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorizeEngineTaskExecution, bindEngineChatSession, createEnginePaths, enqueueTask, getEngineTaskStatus, recordEngineExecutionSpecification, runWorkerLoop, type EnginePaths } from "../engine/engine-core.js";
import { runEngineCycleRounds } from "../engine/engine-cycle-browser.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { extractChatGptChatId, hashChatGptArtifactText } from "../service/chatgpt-artifact-guard.js";
import { recordChatGptComponentChatToken, resolveChatGptComponentLabel, shouldRecordChatGptComponentChatToken } from "../service/chatgpt-component-label.js";
import { buildChatGptEntrypointPlan } from "../service/chatgpt-entrypoint-preset.js";
import { draftInput as executorDraftInput, inspectComposerPreflight as executorInspectComposerPreflight, inventoryChatGptTargets as executorInventoryChatGptTargets, sendPrompt as executorSendPrompt, submitDraft as executorSubmitDraft } from "../service/browser-session-executor.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { recordCmcpGoTrace } from "../Infrastructure/Diagnostics/RuntimeDiagnostics.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";
import { startChatGptRunLoopDaemon } from "./implementation-run-capture.js";
import { assertConsoleToolCatalogContains } from "./catalog.js";
import { spawn } from "node:child_process";

type BrowserDebugTarget = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };
type OpenedChatGptTarget = BrowserDebugTarget & { port: number; chat_id: string | null; web_socket_debugger_url: string | null; runtime_href?: string | null; runtime_chat_id?: string | null };
type ChatTitleMode = "off" | "auto" | "prefix";
type ChatGptReuseOptions = { requireEmptyHomeComposer?: boolean; skippedTargets?: Array<Record<string, unknown>>; forceCreateNew?: boolean };

const CHATGPT_EMPTY_HOME_WARNING_THRESHOLD = 4;
const CHATGPT_EMPTY_HOME_BLOCK_THRESHOLD = 10;

function normalizeDraftText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function hashChatGptDraftText(value: string): string {
  return hashChatGptArtifactText(normalizeDraftText(value));
}

const chatTitleModeSchema = z.enum(["off", "auto", "prefix"]).default("off");

const chatOpenInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  url: z.string().min(1).max(500).default("https://chatgpt.com/"),
  activate: z.boolean().default(true),
  confirmOpen: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatTabInventoryInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatGptRateLimitDetectInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedTargetId: z.string().min(1).optional(),
  maxInspect: z.number().int().min(1).max(20).default(5),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatGptRateLimitDismissInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedTargetId: z.string().min(1),
  confirmDismiss: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatGptComposerPreflightInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedTargetId: z.string().min(1),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatTabCleanupPreviewInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  maxClose: z.number().int().min(1).max(50).default(10),
  keepTargetId: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatTabCleanupInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  dryRun: z.boolean().default(false),
  confirmCleanup: z.boolean().default(false),
  maxClose: z.number().int().min(1).max(50).default(10),
  keepTargetId: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatDeletePlanInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
  requireChatId: z.boolean().default(true),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatDeleteExecuteInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedChatId: z.string().min(1),
  confirmDelete: z.boolean().default(false),
  closeTarget: z.boolean().default(true),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const browserConnectorRefreshPlanInputSchema = z.object({
  timeoutMs: z.number().int().min(5000).max(120000).default(90000),
}).strict();

const chatGptConnectorRefreshInputSchema = z.object({
  confirmRefresh: z.boolean().default(false),
  timeoutMs: z.number().int().min(5000).max(120000).default(90000),
}).strict();

const browserSessionInputDraftSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedTargetId: z.string().min(1),
  draftText: z.string().min(1).max(12000),
  allowOverwrite: z.boolean().default(false),
  expectedExistingHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  confirmDraft: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const browserSessionSubmitSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedTargetId: z.string().min(1),
  expectedDraftHash: z.string().min(1).optional(),
  expectedDraftLength: z.number().int().min(1).optional(),
  confirmSubmit: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatCreateSendInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  prompt: z.string().min(1).max(12000),
  component: z.string().min(1).max(120).optional(),
  taskId: z.string().min(1).max(160).optional(),
  promptId: z.string().min(1).max(160).optional(),
  url: z.string().min(1).max(500).default("https://chatgpt.com/"),
  allowOverwrite: z.boolean().default(false),
  allowGuestRootSession: z.boolean().default(false),
  activate: z.boolean().default(true),
  confirmSend: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(30000).default(10000),
}).strict();

const browserSessionCmcpGoSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  rawCommand: z.string().min(1).max(6000),
  workspacePath: z.string().min(1).optional(),
  componentName: z.string().min(1).optional(),
  taskPreset: z.literal("repo_rc_implementation").default("repo_rc_implementation"),
  maxAutoIterations: z.number().int().min(1).max(100).default(70),
  url: z.string().min(1).max(500).default("https://chatgpt.com/"),
  allowOverwrite: z.boolean().default(false),
  activate: z.boolean().default(true),
  confirmGo: z.boolean().default(false),
  promptMode: z.enum(["enriched", "raw"]).default("enriched"),
  executorMode: z.enum(["engine", "browser"]).default("engine"),
  manageLoop: z.boolean().default(true),
  timeoutMs: z.number().int().min(250).max(30000).default(10000),
}).strict();

const chatAdoptIntoTaskBankSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  componentName: z.string().min(1).max(120),
  workspacePath: z.string().min(1).optional(),
  preferredChatId: z.string().min(1).optional(),
  locator: z.string().regex(/^@[A-Za-z0-9_-]{4,32}$/).optional(),
  requireSingleChat: z.boolean().default(true),
  taskPreset: z.literal("repo_rc_implementation").default("repo_rc_implementation"),
  maxAutoIterations: z.number().int().min(1).max(100).default(70),
  recoverComposer: z.boolean().default(false),
  autoStart: z.boolean().default(false),
  dryRun: z.boolean().default(true),
  activate: z.boolean().default(true),
  confirmAdopt: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(30000).default(10000),
}).strict();

const chatAdoptGoSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  componentName: z.string().min(1).max(120),
  workspacePath: z.string().min(1).optional(),
  preferredChatId: z.string().min(1).optional(),
  locator: z.string().regex(/^@[A-Za-z0-9_-]{4,32}$/).optional(),
  requireSingleChat: z.boolean().default(true),
  taskPreset: z.literal("repo_rc_implementation").default("repo_rc_implementation"),
  maxAutoIterations: z.number().int().min(1).max(100).default(70),
  recoverComposer: z.boolean().default(false),
  activate: z.boolean().default(true),
  confirmGo: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(30000).default(10000),
}).strict();

const browserSessionTitlePrefixSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedTargetId: z.string().min(1).optional(),
  expectedChatId: z.string().min(1).optional(),
  workspacePath: z.string().min(1),
  chatTitleMode: z.enum(["auto", "prefix"]).default("auto"),
  waitForChatId: z.boolean().default(true),
  confirmTitlePrefix: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(30000).default(10000),
}).strict();

const chatGptChatOpenToolNames = [
  "console.read_.browser.chatgpt.tab.inventory",
  "console.read_.browser.session.target.inventory",
  "console.read_.browser.empty.page.summary",
  "console.read_.browser.chatgpt.rate.limit.detect",
  "console.write.browser.chatgpt.rate.limit.dismiss",
  "console.read_.browser.chatgpt.composer.preflight",
  "console.read_.browser.empty.page.cleanup.preview",
  "console.read_.browser.chatgpt.duplicate.tab.cleanup.preview",
  "console.read_.browser.chatgpt.plugin.settings.cleanup.preview",
  "console.read_.browser.chatgpt.blank.target.preview",
  "console.write.browser.session.target.cleanup",
  "console.write.browser.empty.page.cleanup",
  "console.write.browser.chatgpt.duplicate.tab.cleanup",
  "console.write.browser.chatgpt.plugin.settings.cleanup",
  "console.write.browser.chatgpt.blank.target.prune",
  "console.read_.browser.chatgpt.chat.delete.plan",
  "console.write.browser.chatgpt.chat.delete.execute",
  "console.read_.browser.schema.refresh.plan",
  "console.write.browser.schema.refresh.execute",
  "console.write.browser.session.open",
  "console.write.browser.session.input.draft",
  "console.write.browser.session.submit",
  "console.write.browser.chatgpt.chat.create.send",
  "console.write.browser.session.cmcp.go",
  "console.write.browser.chatgpt.chat.adopt_into_task_bank",
  "console.write.browser.chatgpt.chat.adopt_go",
  "console.write.browser.session.title.prefix",
] as const;

export function registerChatGptChatOpenTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  assertConsoleToolCatalogContains(chatGptChatOpenToolNames);
  server.registerTool("console.read_.browser.chatgpt.tab.inventory", {
    description: "Read-only inventory of supervised ChatGPT DevTools page targets, including empty home tabs and duplicate chat ids.",
    inputSchema: chatTabInventoryInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await inventoryChatGptTabs(input)));

  server.registerTool("console.read_.browser.session.target.inventory", {
    description: "Read-only inventory of supervised browser page targets, including empty root targets and duplicate session ids.",
    inputSchema: chatTabInventoryInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await inventoryBrowserSessionTargets(input)));

  server.registerTool("console.read_.browser.empty.page.summary", {
    description: "Read-only count summary of supervised empty browser pages. It returns counts only and omits urls, titles, target ids, session ids, and debugger endpoints.",
    inputSchema: chatTabInventoryInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await summarizeBrowserEmptyPages(input)));

  server.registerTool("console.read_.browser.chatgpt.rate.limit.detect", {
    description: "Read-only detection of visible ChatGPT rate-limit or too-many-requests blocking state across supervised ChatGPT tabs. It never submits, clicks, closes, or writes input.",
    inputSchema: chatGptRateLimitDetectInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await detectChatGptRateLimit(input)));

  server.registerTool("console.write.browser.chatgpt.rate.limit.dismiss", {
    description: "Dismiss one visible persistent ChatGPT rate-limit banner on an explicitly selected target after confirmation. It does not submit or retry a prompt.",
    inputSchema: chatGptRateLimitDismissInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await dismissChatGptRateLimit(input)));

  server.registerTool("console.read_.browser.chatgpt.composer.preflight", {
    description: "Read-only ChatGPT composer preflight diagnostics for visible overlays, composer readiness, and send control state. It never clicks, submits, closes, or writes input.",
    inputSchema: chatGptComposerPreflightInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await inspectChatGptComposerPreflight(input)));

  server.registerTool("console.read_.browser.empty.page.cleanup.preview", {
    description: "Read-only preview of supervised empty browser pages eligible for cleanup. It never changes browser state and returns counts only.",
    inputSchema: chatTabCleanupPreviewInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await previewBrowserEmptyPageCleanup(input)));

  server.registerTool("console.read_.browser.chatgpt.duplicate.tab.cleanup.preview", {
    description: "Read-only preview of duplicate supervised ChatGPT chat tabs eligible for cleanup. It never changes browser state and returns counts only.",
    inputSchema: chatTabCleanupPreviewInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await previewDuplicateChatGptTabCleanup(input)));

  server.registerTool("console.read_.browser.chatgpt.plugin.settings.cleanup.preview", {
    description: "Read-only preview of supervised background ChatGPT settings tabs eligible for cleanup, including Plugins/plugin_* surfaces. The active browser tab is always preserved.",
    inputSchema: chatTabCleanupPreviewInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await previewChatGptPluginSettingsCleanup(input)));

  server.registerTool("console.read_.browser.chatgpt.blank.target.preview", {
    description: "Read-only preview for blank supervised ChatGPT page targets. It returns counts only.",
    inputSchema: chatTabCleanupPreviewInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await previewNoIdChatGptTab(input)));

  server.registerTool("console.write.browser.session.target.cleanup", {
    description: "Execute confirmed empty supervised browser root target cleanup. Preview first with a read-only inventory or preview tool.",
    inputSchema: chatTabCleanupInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await cleanupBrowserSessionTargets(input)));

  server.registerTool("console.write.browser.empty.page.cleanup", {
    description: "Execute confirmed empty browser page cleanup. Requires dryRun=false and confirmCleanup=true; use the read-only preview tool for planning.",
    inputSchema: chatTabCleanupInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await cleanupBrowserEmptyPages(input)));

  server.registerTool("console.write.browser.chatgpt.duplicate.tab.cleanup", {
    description: "Execute confirmed duplicate ChatGPT tab cleanup. Keeps one supervised target per chat id and closes only extra duplicate targets.",
    inputSchema: chatTabCleanupInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await cleanupDuplicateChatGptTabs(input)));

  server.registerTool("console.write.browser.chatgpt.plugin.settings.cleanup", {
    description: "Execute confirmed cleanup of background ChatGPT settings tabs, including Plugins/plugin_* surfaces. It preserves the active browser tab and revalidates the settings URL immediately before close.",
    inputSchema: chatTabCleanupInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await cleanupChatGptPluginSettingsTabs(input)));

  server.registerTool("console.write.browser.chatgpt.blank.target.prune", {
    description: "Apply confirmed pruning for blank supervised ChatGPT page targets.",
    inputSchema: chatTabCleanupInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await closeNoIdChatGptTabs(input)));

  server.registerTool("console.read_.browser.chatgpt.chat.delete.plan", {
    description: "Read-only plan for deleting a supervised ChatGPT conversation by chat id. It never deletes or closes anything.",
    inputSchema: chatDeletePlanInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await planChatGptChatDelete(input)));

  server.registerTool("console.write.browser.chatgpt.chat.delete.execute", {
    description: "Delete a supervised ChatGPT conversation after explicit confirmation and expected chat id match.",
    inputSchema: chatDeleteExecuteInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await executeChatGptChatDelete(input)));

  server.registerTool("console.read_.browser.schema.refresh.plan", {
    description: "Read-only plan for refreshing the ChatGPT connector schema after this MCP runtime has been rebuilt and restarted. It never clicks, reconnects, refreshes, or changes browser state.",
    inputSchema: browserConnectorRefreshPlanInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(planBrowserConnectorSchemaRefresh(input)));

  server.registerTool("console.write.browser.schema.refresh.execute", {
    description: "Compatibility executor for the existing ChatGPT connector schema refresh flow after explicit confirmation.",
    inputSchema: chatGptConnectorRefreshInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await refreshChatGptConnectorSchema(input)));

  server.registerTool("console.write.browser.session.open", {
    description: "Open a supported URL in the existing supervised browser session. It does not write page input or submit anything.",
    inputSchema: chatOpenInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await openChatGptChat(policy, input)));

  server.registerTool("console.write.browser.session.input.draft", {
    description: "Write text into the current bound page input. Draft-only: this tool cannot submit anything.",
    inputSchema: browserSessionInputDraftSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await draftBrowserSessionInput(input)));

  server.registerTool("console.write.browser.session.submit", {
    description: "Submit the current bound page state after explicit user confirmation. This tool does not accept text.",
    inputSchema: browserSessionSubmitSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await submitBrowserSession(input)));

  server.registerTool("console.write.browser.chatgpt.chat.create.send", {
    description: "Create or reuse a ChatGPT chat, write the provided prompt, submit it after explicit confirmation, and return chat id, URL, and target id.",
    inputSchema: chatCreateSendInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await createSubmitChatGptChat(policy, input)));

  server.registerTool("console.write.browser.session.cmcp.go", {
    description: "Use this tool whenever the user issues an imperative command matching 'cmcp go <component> [M<number>]'. The word 'go' is explicit confirmation to start now: call this tool in the same turn instead of acknowledging, describing, simulating, or predicting a launch. Map M<number> to maxAutoIterations and set confirmGo=true. The default engine executor prepares the task-scoped phase plan and dispatches the bounded run_n browser cycle. Browser mode remains an explicit one-shot compatibility path. Do not claim execution started unless the returned engine run_n or explicit browser submission status confirms it.",
    inputSchema: browserSessionCmcpGoSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await runBrowserSessionCmcpGo(policy, baseDir, input)));

  server.registerTool("console.write.browser.chatgpt.chat.adopt_into_task_bank", {
    description: "Adopt an existing supervised ChatGPT conversation into the engine task bank without starting execution. An optional locator such as @token may discover a mobile-originated chat through authenticated conversation history and open its desktop target when absent.",
    inputSchema: chatAdoptIntoTaskBankSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await adoptChatGptChatIntoTaskBank(policy, baseDir, input)));

  server.registerTool("console.write.browser.chatgpt.chat.adopt_go", {
    description: "Use this tool whenever the user issues ADOPT GO or ADOPT GO M<n>. GO is explicit confirmation to execute now. Resolve the existing chat by preferredChatId or optional @locator, adopt it into the task bank, force live execution, and immediately run up to maxAutoIterations full engine cycles. Call this tool in the same turn instead of only describing or interpreting the command.",
    inputSchema: chatAdoptGoSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await adoptChatGptChatGo(policy, baseDir, input)));

  server.registerTool("console.write.browser.session.title.prefix", {
    description: "Apply a title prefix after a session has a stable chat id. This tool does not write page input or submit anything.",
    inputSchema: browserSessionTitlePrefixSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await applyBrowserSessionTitlePrefix(policy, input)));

}

async function inventoryChatGptTabs(input: z.infer<typeof chatTabInventoryInputSchema>): Promise<Record<string, unknown>> {
  const inventory = await executorInventoryChatGptTargets(input);
  return { ok: true, status: "CHATGPT_TAB_INVENTORY_READY", ...inventory, policy: buildChatTabInventoryPolicy() };
}

async function adoptChatGptChatGo(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof chatAdoptGoSchema>): Promise<Record<string, unknown>> {
  return await adoptChatGptChatIntoTaskBank(policy, baseDir, {
    ...input,
    autoStart: true,
    dryRun: false,
    confirmAdopt: input.confirmGo,
  });
}

async function adoptChatGptChatIntoTaskBank(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof chatAdoptIntoTaskBankSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmAdopt) {
    return {
      ok: false,
      status: "CONFIRM_CHAT_ADOPT_REQUIRED",
      component_name: input.componentName,
      accepts_workspace_path: true,
      will_create_engine_task: true,
      will_bind_existing_chat: true,
      will_write_input: false,
      will_submit: false,
      policy: buildChatAdoptIntoTaskBankPolicy(),
    };
  }

  const resolved = input.locator
    ? await resolveChatGptAdoptionTargetByLocator(input.ports, input.locator, input.timeoutMs)
    : await resolveChatGptAdoptionTarget(input.ports, input.preferredChatId, input.requireSingleChat, input.timeoutMs);
  if (resolved.ok !== true || !resolved.target) {
    return {
      ok: false,
      status: String(resolved.status ?? "CHAT_ADOPT_TARGET_NOT_READY"),
      component_name: input.componentName,
      accepts_workspace_path: true,
      resolver: resolved,
      policy: buildChatAdoptIntoTaskBankPolicy(),
    };
  }

  const target = resolved.target;
  if (input.activate && target.id) {
    await activateDevToolsTarget(target.port, target.id, input.timeoutMs);
  }

  const engineRoot = assertAllowedRoot(path.resolve(baseDir), policy.allowedRoots);
  const enginePaths = createEnginePaths(engineRoot);
  const executionDryRun = input.autoStart ? false : input.dryRun;
  const workspacePath = input.workspacePath ?? (path.basename(path.resolve(baseDir)).toLowerCase() === input.componentName.trim().toLowerCase()
    ? path.resolve(baseDir)
    : inferCmcpGoWorkspacePath(input.componentName, `Adopt go ${input.componentName} M${input.maxAutoIterations}`));
  const rawCommand = `Adopt go ${input.componentName} M${input.maxAutoIterations}`;
  const plan = buildChatGptEntrypointPlan({ rawPrompt: rawCommand, workspacePath, componentName: input.componentName, taskPreset: input.taskPreset, maxAutoIterations: input.maxAutoIterations });
  const enrichedPrompt = typeof plan.enrichedPrompt === "string" ? plan.enrichedPrompt : "";
  const enqueue = await enqueueTask(enginePaths, input.componentName, executionDryRun === false, "mcp", workspacePath);
  if (enqueue.ok !== true || typeof enqueue.task_id !== "string") {
    return {
      ok: false,
      status: "CHAT_ADOPT_ENGINE_ENQUEUE_BLOCKED",
      component_name: input.componentName,
      accepts_workspace_path: true,
      selected: compactChatGptTarget(target),
      engine: { enqueue },
      policy: buildChatAdoptIntoTaskBankPolicy(),
    };
  }

  const bindingInput = {
    ok: true,
    status: "CHATGPT_EXISTING_CHAT_SELECTED_FOR_ADOPTION",
    selected: target,
    chat_id: target.chat_id,
    current_url: target.url ?? null,
    port: target.port,
    reused_existing_target: true,
    will_submit: false,
  };
  const specification = enrichedPrompt.length > 0
    ? await recordEngineExecutionSpecification(enginePaths, String(enqueue.task_id), { content: enrichedPrompt, sourcePrompt: rawCommand, templateVersion: "repo_rc_implementation_v1" })
    : { ok: false, status: "CHAT_ADOPT_SPECIFICATION_EMPTY" };
  const binding = await bindEngineChatSession(enginePaths, String(enqueue.task_id), bindingInput);
  const authorization = input.autoStart && binding.ok === true && specification.ok === true
    ? await authorizeEngineTaskExecution(enginePaths, String(enqueue.task_id), { authorizedBy: "adopt", maxAutoIterations: input.maxAutoIterations })
    : { ok: binding.ok === true && specification.ok === true, status: input.autoStart ? "CHAT_ADOPT_AUTHORIZATION_SKIPPED_PREREQUISITE_BLOCKED" : "CHAT_ADOPT_AUTHORIZATION_NOT_REQUESTED" };
  const loop = input.autoStart && binding.ok === true && authorization.ok === true
    ? await runWorkerLoop(enginePaths, { taskId: String(enqueue.task_id), stopOnIdle: true, stopOnWaitingUser: true })
    : null;
  const taskStatus = input.autoStart && loop?.ok === true
    ? await getEngineTaskStatus(enginePaths, String(enqueue.task_id))
    : null;
  const taskRecord = taskStatus && typeof taskStatus.task === "object" && taskStatus.task !== null
    ? taskStatus.task as Record<string, unknown>
    : {};
  const dispatchDecision = input.autoStart ? resolveCmcpGoAutoDispatch(taskRecord) : null;
  const cycles = input.autoStart && dispatchDecision?.dispatch === true
    ? await runEngineCycleRounds(enginePaths, {
        policy,
        baseDir,
        ports: input.ports,
        url: target.url ?? "https://chatgpt.com/",
        activate: input.activate,
        allowOverwrite: false,
        recoverComposer: input.recoverComposer,
        maxMessages: 30,
        timeoutMs: input.timeoutMs,
        readinessProfile: "rc_gate",
        gatewayMaxOutputTokens: 1200,
        gatewayTemperature: 0.1,
        gatewayTimeoutMs: 60000,
        gatewayRaw: false,
      }, { taskId: String(enqueue.task_id), maxRounds: input.maxAutoIterations, maxStepsPerRound: 8, stopOnBlocked: true, stopOnNotReady: true })
    : null;
  const adopted = binding.ok === true;
  const started = input.autoStart && authorization.ok === true && loop?.ok === true && cycles?.ok === true;
  return {
    ok: input.autoStart ? adopted && started : adopted,
    status: input.autoStart
      ? (started ? "CHAT_ADOPTED_AND_FULL_CYCLES_STARTED" : "CHAT_ADOPT_GO_BLOCKED")
      : (adopted ? "CHAT_ADOPTED_INTO_TASK_BANK" : "CHAT_ADOPT_BIND_BLOCKED"),
    component_name: input.componentName,
    workspace_path: workspacePath,
    accepts_workspace_path: true,
    task_preset: input.taskPreset,
    plan: summarizeCmcpGoPlan(plan, enrichedPrompt, enrichedPrompt.length > 0 ? hashChatGptDraftText(enrichedPrompt) : null),
    max_auto_iterations: input.maxAutoIterations,
    auto_start: input.autoStart,
    locator: input.locator ?? null,
    dry_run: executionDryRun,
    task_id: enqueue.task_id,
    chat_id: target.chat_id,
    target_id: target.id ?? null,
    current_url: target.url ?? null,
    resolver: resolved,
    engine: { enqueue, specification, binding, authorization, loop, task_status: taskStatus, dispatch_decision: dispatchDecision, cycles, max_ticks: null, tick_limit: "task_state" },
    next_tool: input.autoStart ? null : "console.write.engine.cycle.run_n",
    next_tool_args: input.autoStart ? null : { taskId: enqueue.task_id, maxRounds: input.maxAutoIterations, maxStepsPerRound: 8 },
    policy: buildChatAdoptIntoTaskBankPolicy(),
  };
}

async function resolveChatGptAdoptionTarget(ports: number[], preferredChatId: string | undefined, requireSingleChat: boolean, timeoutMs: number): Promise<{ ok: boolean; status: string; target: OpenedChatGptTarget | null; inventory?: Record<string, unknown>; candidate_count?: number; unique_chat_id_count?: number }> {
  if (preferredChatId) {
    const existing = await findBestChatGptTargetForChatId(ports, preferredChatId, timeoutMs);
    if (existing) return { ok: true, status: "CHAT_ADOPT_PREFERRED_CHAT_READY", target: existing };
    const opened = await openChatGptTargetForChatId(ports, preferredChatId, timeoutMs);
    return opened ? { ok: true, status: "CHAT_ADOPT_PREFERRED_CHAT_OPENED", target: opened } : { ok: false, status: "CHAT_ADOPT_PREFERRED_CHAT_NOT_FOUND", target: null };
  }

  const inventory = await collectChatGptTabInventory(ports, timeoutMs);
  const targets = (Array.isArray(inventory.targets) ? inventory.targets as Array<Record<string, unknown>> : [])
    .filter((target) => typeof target.chat_id === "string" && String(target.chat_id).length > 0);
  const uniqueChatIds = [...new Set(targets.map((target) => String(target.chat_id)).filter(Boolean))];
  if (requireSingleChat && uniqueChatIds.length !== 1) {
    return {
      ok: false,
      status: uniqueChatIds.length === 0 ? "CHAT_ADOPT_CHAT_ID_MISSING" : "CHAT_ADOPT_AMBIGUOUS_CHAT_ID",
      target: null,
      inventory,
      candidate_count: targets.length,
      unique_chat_id_count: uniqueChatIds.length,
    };
  }

  const chatId = uniqueChatIds[0] ?? null;
  if (!chatId) return { ok: false, status: "CHAT_ADOPT_CHAT_ID_MISSING", target: null, inventory, candidate_count: targets.length, unique_chat_id_count: uniqueChatIds.length };
  const target = await findBestChatGptTargetForChatId(ports, chatId, timeoutMs);
  return target ? { ok: true, status: "CHAT_ADOPT_SINGLE_CHAT_READY", target, inventory, candidate_count: targets.length, unique_chat_id_count: uniqueChatIds.length } : { ok: false, status: "CHAT_ADOPT_TARGET_NOT_FOUND", target: null, inventory, candidate_count: targets.length, unique_chat_id_count: uniqueChatIds.length };
}

async function resolveChatGptAdoptionTargetByLocator(ports: number[], locator: string, timeoutMs: number): Promise<{ ok: boolean; status: string; target: OpenedChatGptTarget | null; locator: string; discovery?: unknown }> {
  const inventory = await collectChatGptTabInventory(ports, timeoutMs);
  const candidates = Array.isArray(inventory.targets) ? inventory.targets as Array<Record<string, unknown>> : [];
  let host: OpenedChatGptTarget | null = null;
  for (const candidate of candidates) {
    const targetId = stringOrNull(candidate.id);
    const port = numberOrNull(candidate.port);
    if (!targetId || port === null) continue;
    const resolved = await findDevToolsTargetById([port], targetId, timeoutMs);
    if (resolved?.web_socket_debugger_url || resolved?.webSocketDebuggerUrl) { host = resolved; break; }
  }
  if (!host) return { ok: false, status: "CHAT_ADOPT_LOCATOR_NEED_AUTHENTICATED_BROWSER", target: null, locator };
  const initialWebSocketUrl = host.web_socket_debugger_url ?? host.webSocketDebuggerUrl ?? null;
  if (!initialWebSocketUrl || !host.id) return { ok: false, status: "CHAT_ADOPT_LOCATOR_NEED_DEVTOOLS_WEBSOCKET", target: null, locator };

  const reloadRequestedAt = new Date().toISOString();
  const reload = await safeSendDevToolsCommand(initialWebSocketUrl, "Page.reload", { ignoreCache: true }, Math.min(Math.max(timeoutMs, 3000), 10000), "CHAT_ADOPT_LOCATOR_PAGE_RELOAD_FAILED");
  if (reload.ok !== true) return { ok: false, status: "CHAT_ADOPT_LOCATOR_PAGE_RELOAD_FAILED", target: null, locator, discovery: reload };
  await delay(1500);
  const refreshedHost = await resolveChatGptDocumentTarget(host.port, host.id, Math.min(Math.max(timeoutMs, 5000), 15000));
  const refreshedWebSocketUrl = refreshedHost?.web_socket_debugger_url ?? refreshedHost?.webSocketDebuggerUrl ?? null;
  if (!refreshedHost || !refreshedWebSocketUrl) return { ok: false, status: "CHAT_ADOPT_LOCATOR_PAGE_RELOAD_NOT_READY", target: null, locator };
  const ready = await resolveRuntimeDocumentReady(refreshedWebSocketUrl, Math.min(Math.max(timeoutMs, 5000), 15000));
  if (!Boolean((ready as { ok?: unknown }).ok)) return { ok: false, status: "CHAT_ADOPT_LOCATOR_PAGE_RELOAD_NOT_READY", target: null, locator };

  const readyRecord = asRecord(ready);
  const reloadConfirmation = {
    ok: true,
    status: "CHAT_ADOPT_LOCATOR_PAGE_RELOAD_CONFIRMED",
    method: "Page.reload",
    ignore_cache: true,
    requested_at: reloadRequestedAt,
    confirmed_at: new Date().toISOString(),
    target_id: refreshedHost.id ?? host.id,
    port: refreshedHost.port,
    href: stringOrNull(readyRecord?.href) ?? refreshedHost.url ?? null,
    ready_state: stringOrNull(readyRecord?.readyState),
    sequence: "reload_confirmed_immediately_before_global_search",
  };

  const discoveryResult = await safeEvaluateInTarget(refreshedWebSocketUrl, buildConversationLocatorDiscoveryExpression(locator), Math.min(Math.max(timeoutMs, 5000), 30000), "CHAT_ADOPT_LOCATOR_DISCOVERY_FAILED");
  const discovery = { ...(asRecord(discoveryResult) ?? { value: discoveryResult }), reload_confirmation: reloadConfirmation };
  const record = asRecord(discovery);
  const chatId = stringOrNull(record?.chat_id);
  if (!chatId) return { ok: false, status: stringOrNull(record?.status) ?? "CHAT_ADOPT_LOCATOR_NOT_FOUND", target: null, locator, discovery };

  const existing = await findBestChatGptTargetForChatId(ports, chatId, timeoutMs);
  if (existing) return { ok: true, status: "CHAT_ADOPT_LOCATOR_EXISTING_TARGET_READY", target: existing, locator, discovery };

  const opened = await openChatGptTargetForChatId(ports, chatId, timeoutMs);
  return opened
    ? { ok: true, status: "CHAT_ADOPT_LOCATOR_TARGET_OPENED", target: opened, locator, discovery }
    : { ok: false, status: "CHAT_ADOPT_LOCATOR_CHAT_OPEN_FAILED", target: null, locator, discovery };
}

function buildConversationLocatorDiscoveryExpression(locator: string): string {
  const expectedLocator = JSON.stringify(locator.toLowerCase());
  return `(async () => {
    const locator = ${expectedLocator};
    const searchQuery = locator.startsWith('@') ? locator.slice(1) : locator;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const visible = (node) => {
      if (!node || !(node instanceof Element)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const waitFor = async (probe, timeoutMs, pollMs = 100) => {
      const deadline = Date.now() + timeoutMs;
      let value = null;
      while (Date.now() <= deadline) {
        value = probe();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return value;
    };
    const readLabel = (node) => normalize(
      node?.getAttribute?.('aria-label') ||
      node?.getAttribute?.('title') ||
      node?.getAttribute?.('data-testid') ||
      node?.innerText ||
      node?.textContent ||
      ''
    );
    const findSearchInput = () => Array.from(document.querySelectorAll('input, textarea'))
      .filter(visible)
      .find((node) => {
        const marker = normalize(
          node.getAttribute('placeholder') ||
          node.getAttribute('aria-label') ||
          node.getAttribute('data-testid') ||
          ''
        );
        return marker.includes('search');
      }) || null;
    let searchInput = findSearchInput();
    if (!searchInput) {
      const searchControl = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .filter(visible)
        .find((node) => {
          const label = readLabel(node);
          return label === 'search' || label === 'search chats' || label.includes('search chats');
        }) || null;
      if (!searchControl) {
        return { ok: false, status: 'CHAT_ADOPT_LOCATOR_GLOBAL_SEARCH_CONTROL_NOT_FOUND', locator };
      }
      searchControl.click();
      searchInput = await waitFor(findSearchInput, 5000);
    }
    if (!searchInput) {
      return { ok: false, status: 'CHAT_ADOPT_LOCATOR_GLOBAL_SEARCH_INPUT_NOT_FOUND', locator };
    }
    searchInput.focus();
    const descriptor = searchInput instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor?.set) descriptor.set.call(searchInput, searchQuery);
    else searchInput.value = searchQuery;
    searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: searchQuery }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    const searchSurface = searchInput.closest('[role="dialog"], [aria-modal="true"]') || document;
    const parseCurrentChat = () => {
      const parts = location.pathname.split('/').filter(Boolean);
      const index = parts.findIndex((part) => part === 'c' || part === 'chat');
      const chatId = index >= 0 ? String(parts[index + 1] || '') : '';
      return chatId ? { chat_id: chatId, href: location.href } : null;
    };
    const directLink = await waitFor(() => Array.from(searchSurface.querySelectorAll('a[href*="/c/"], a[href*="/chat/"]')).filter(visible)[0] || null, 1500, 100);
    if (directLink) {
      directLink.click();
    } else {
      const resultCandidates = Array.from(searchSurface.querySelectorAll('[role="option"], [role="listitem"], button, [role="button"], li'))
        .filter(visible)
        .filter((node) => !node.contains(searchInput) && node !== searchInput)
        .filter((node) => {
          const text = normalize(node.textContent || node.innerText || '');
          if (!text || text === 'no results' || text === 'no chats found') return false;
          const label = readLabel(node);
          if (label.includes('close') || label.includes('cancel') || label.includes('search')) return false;
          return true;
        });
      const uniqueCandidates = resultCandidates.filter((node, index, nodes) => !nodes.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
      if (uniqueCandidates.length !== 1) {
        return {
          ok: false,
          status: uniqueCandidates.length > 1 ? 'CHAT_ADOPT_LOCATOR_AMBIGUOUS' : 'CHAT_ADOPT_LOCATOR_RESULT_CONTROL_NOT_FOUND',
          match_count: uniqueCandidates.length,
          search_mode: 'global_chat_search_ui_click',
          search_query: searchQuery,
          candidate_labels: uniqueCandidates.map((node) => readLabel(node).slice(0, 200)),
          search_text_preview: normalize(searchSurface.textContent || '').slice(0, 500),
        };
      }
      uniqueCandidates[0].click();
    }
    const opened = await waitFor(parseCurrentChat, 10000, 150);
    if (!opened) {
      return {
        ok: false,
        status: 'CHAT_ADOPT_LOCATOR_RESULT_CLICK_DID_NOT_OPEN_CHAT',
        match_count: 1,
        search_mode: 'global_chat_search_ui_click',
        search_query: searchQuery,
        current_href: location.href,
      };
    }
    const visibleSearchBackdrop = () => Array.from(document.querySelectorAll('.fixed.inset-0, [role="dialog"], [aria-modal="true"]'))
      .filter(visible)
      .find((node) => {
        const text = normalize(node.textContent || node.innerText || '');
        return text.includes('no results') || Boolean(node.querySelector('input[placeholder*="search" i], input[aria-label*="search" i]'));
      }) || null;
    const closeControl = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .find((node) => {
        const label = readLabel(node);
        return label === 'close' || label === 'cancel' || label.includes('close search');
      }) || null;
    if (closeControl) closeControl.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    const searchOverlayClosed = await waitFor(() => visibleSearchBackdrop() ? null : true, 3000, 100);
    return {
      ok: true,
      status: searchOverlayClosed ? 'CHAT_ADOPT_LOCATOR_FOUND' : 'CHAT_ADOPT_LOCATOR_FOUND_SEARCH_OVERLAY_STILL_OPEN',
      chat_id: opened.chat_id,
      href: opened.href,
      match_count: 1,
      search_mode: 'global_chat_search_ui_click',
      search_overlay_closed: Boolean(searchOverlayClosed),
    };
  })()`;
}

async function cleanupChatGptTabs(input: z.infer<typeof chatTabCleanupInputSchema>): Promise<Record<string, unknown>> {
  const inventory = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  const rawCandidates = (inventory.empty_home_targets as OpenedChatGptTarget[]).filter((target) => target.id && target.id !== input.keepTargetId);
  const safetyChecks: Array<Record<string, unknown>> = [];
  const safeCandidates: OpenedChatGptTarget[] = [];
  for (const target of rawCandidates) {
    try {
      const safety = await inspectCloseSafety(target, input.timeoutMs);
      safetyChecks.push({ target_id: target.id, port: target.port, ...safety });
      if (safety.ok === true) safeCandidates.push(target);
    } catch (error) {
      safetyChecks.push({ target_id: target.id, port: target.port, ok: false, status: "SAFETY_CHECK_EXCEPTION", error: error instanceof Error ? error.message : String(error), target: compactChatGptTarget(target) });
    }
  }
  const selected = safeCandidates.slice(0, input.maxClose);
  if (input.dryRun || !input.confirmCleanup) {
    return {
      ok: false,
      status: input.dryRun ? "CHATGPT_TAB_CLEANUP_DRY_RUN" : "CONFIRM_CLEANUP_REQUIRED",
      dry_run: input.dryRun,
      confirm_cleanup: input.confirmCleanup,
      candidate_count: safeCandidates.length,
      selected_count: selected.length,
      selected_targets: selected.map(compactChatGptTarget),
      safety_checks: safetyChecks,
      inventory,
      policy: buildChatTabCleanupPolicy(),
    };
  }

  const closed: Array<Record<string, unknown>> = [];
  for (const target of selected) {
    try {
      const body = await closeDevToolsTarget(target.port, String(target.id), input.timeoutMs);
      closed.push({ ok: true, status: "TARGET_CLOSE_REQUESTED", target: compactChatGptTarget(target), body });
    } catch (error) {
      closed.push({ ok: false, status: "TARGET_CLOSE_FAILED", target: compactChatGptTarget(target), error: error instanceof Error ? error.message : String(error) });
    }
  }
  const after = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  return { ok: closed.every((item) => item.ok === true), status: "CHATGPT_TAB_CLEANUP_DONE", dry_run: false, closed_count: closed.filter((item) => item.ok === true).length, closed, before: inventory, after, policy: buildChatTabCleanupPolicy() };
}

async function inventoryBrowserSessionTargets(input: z.infer<typeof chatTabInventoryInputSchema>): Promise<Record<string, unknown>> {
  const result = await inventoryChatGptTabs(input);
  return { ...result, status: "BROWSER_SESSION_TARGET_INVENTORY_READY", policy: buildBrowserSessionTargetInventoryPolicy() };
}

async function summarizeBrowserEmptyPages(input: z.infer<typeof chatTabInventoryInputSchema>): Promise<Record<string, unknown>> {
  const source = await inventoryBrowserSessionTargets(input);
  const total = Number(source["total_" + "chat" + "gpt_targets"] ?? 0);
  const empty = Number(source["empty_home_count"] ?? 0);
  const active = Number(source["chat_target_count"] ?? 0);
  const duplicate = Number(source["duplicate_" + "chat_id_count"] ?? 0);
  return {
    ok: true,
    status: "BROWSER_EMPTY_PAGE_SUMMARY_READY",
    ports: source.ports,
    empty_page_candidate_count: empty,
    active_page_count: active,
    duplicate_page_group_count: duplicate,
    unknown_or_other_page_count: Math.max(0, total - empty - active),
    inspected_page_count: total,
    details_omitted: true,
    policy: buildBrowserEmptyPageSummaryPolicy(),
  };
}

async function detectChatGptRateLimit(input: z.infer<typeof chatGptRateLimitDetectInputSchema>): Promise<Record<string, unknown>> {
  const inspected: Array<Record<string, unknown>> = [];
  const signals: Array<Record<string, unknown>> = [];
  const targets = input.expectedTargetId
    ? [await findDevToolsTargetById(input.ports, input.expectedTargetId, input.timeoutMs)].filter((target): target is OpenedChatGptTarget => target !== null)
    : await collectRateLimitProbeTargets(input.ports, input.timeoutMs, input.maxInspect);

  for (const target of targets) {
    const webSocketUrl = target.web_socket_debugger_url ?? target.webSocketDebuggerUrl ?? null;
    if (!webSocketUrl) {
      inspected.push({ target: compactChatGptTarget(target), ok: false, status: "RATE_LIMIT_PROBE_SKIPPED_NO_WEBSOCKET" });
      continue;
    }
    const probe = await safeEvaluateInTarget(webSocketUrl, buildRateLimitProbeExpression(), Math.min(input.timeoutMs, 1500), "RATE_LIMIT_PROBE_EVALUATION_FAILED");
    const detected = Boolean((probe as { detected?: unknown }).detected);
    inspected.push({ target: compactChatGptTarget(target), ok: true, status: detected ? "RATE_LIMIT_SIGNAL_DETECTED" : "RATE_LIMIT_SIGNAL_NOT_DETECTED", probe });
    if (detected) signals.push({ target: compactChatGptTarget(target), probe });
  }

  return {
    ok: true,
    status: signals.length > 0 ? "CHATGPT_RATE_LIMIT_DETECTED" : "CHATGPT_RATE_LIMIT_NOT_DETECTED",
    detected: signals.length > 0,
    severity: signals.length > 0 ? "blocking" : "none",
    inspected_target_count: inspected.length,
    signal_count: signals.length,
    signals,
    inspected,
    policy: buildChatGptRateLimitDetectPolicy(),
  };
}

async function dismissChatGptRateLimit(input: z.infer<typeof chatGptRateLimitDismissInputSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmDismiss) {
    return { ok: false, status: "CONFIRM_RATE_LIMIT_DISMISS_REQUIRED", expected_target_id: input.expectedTargetId, policy: buildChatGptRateLimitDismissPolicy() };
  }
  const target = await findDevToolsTargetById(input.ports, input.expectedTargetId, input.timeoutMs);
  if (!target) return { ok: false, status: "RATE_LIMIT_DISMISS_TARGET_NOT_FOUND", expected_target_id: input.expectedTargetId, policy: buildChatGptRateLimitDismissPolicy() };
  const webSocketUrl = target.web_socket_debugger_url ?? target.webSocketDebuggerUrl ?? null;
  if (!webSocketUrl) return { ok: false, status: "RATE_LIMIT_DISMISS_WEBSOCKET_MISSING", selected: compactChatGptTarget(target), policy: buildChatGptRateLimitDismissPolicy() };
  const before = await safeEvaluateInTarget(webSocketUrl, buildRateLimitProbeExpression(), Math.min(input.timeoutMs, 1500), "RATE_LIMIT_PROBE_EVALUATION_FAILED");
  if (!Boolean((before as { detected?: unknown }).detected)) {
    return { ok: true, status: "RATE_LIMIT_BANNER_NOT_PRESENT", dismissed: false, selected: compactChatGptTarget(target), before, policy: buildChatGptRateLimitDismissPolicy() };
  }
  const dismiss = await safeEvaluateInTarget(webSocketUrl, buildRateLimitDismissExpression(), Math.min(input.timeoutMs, 3000), "RATE_LIMIT_DISMISS_EVALUATION_FAILED");
  await delay(250);
  const after = await safeEvaluateInTarget(webSocketUrl, buildRateLimitProbeExpression(), Math.min(input.timeoutMs, 1500), "RATE_LIMIT_PROBE_EVALUATION_FAILED");
  const retryAfterMs = numberOrNull((before as Record<string, unknown>).retryAfterMs) ?? 90000;
  const dismissed = Boolean((dismiss as { dismissed?: unknown }).dismissed);
  return {
    ok: dismissed,
    status: dismissed ? "RATE_LIMIT_BANNER_DISMISSED" : "RATE_LIMIT_BANNER_DISMISS_NOT_APPLIED",
    dismissed,
    selected: compactChatGptTarget(target),
    retry_after_ms: retryAfterMs,
    cooldown_until: new Date(Date.now() + retryAfterMs).toISOString(),
    before,
    dismiss,
    after,
    policy: buildChatGptRateLimitDismissPolicy(),
  };
}

// A single check can catch a banner mid-flicker (e.g. right as it's being dismissed) and
// falsely block a submit that would have succeeded a few seconds later. Poll a few times before
// giving up - this is NOT the full "wait a few minutes" backoff ChatGPT's own modal asks for
// (that has to happen at the orchestration/retry layer, not inside one blocking tool call), it
// only absorbs short-lived flicker so we don't hard-fail on a banner that's already clearing.
async function waitForChatGptRateLimitToClear(args: { ports: number[]; expectedTargetId: string; timeoutMs: number; maxAttempts: number; pollMs: number }): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = { ok: true, detected: false, status: "CHATGPT_RATE_LIMIT_NOT_DETECTED" };
  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    last = await detectChatGptRateLimit({ ports: args.ports, expectedTargetId: args.expectedTargetId, maxInspect: 1, timeoutMs: args.timeoutMs });
    if (last.detected !== true) return { ...last, checked_attempts: attempt };
    if (attempt < args.maxAttempts) await delay(args.pollMs);
  }
  return { ...last, checked_attempts: args.maxAttempts };
}

async function collectRateLimitProbeTargets(ports: number[], timeoutMs: number, maxInspect: number): Promise<OpenedChatGptTarget[]> {
  const inventory = await collectChatGptTabInventory(ports, timeoutMs);
  const records = Array.isArray(inventory.targets) ? inventory.targets as Array<Record<string, unknown>> : [];
  const targets: OpenedChatGptTarget[] = [];
  for (const record of records) {
    const targetId = stringOrNull(record.id);
    const port = numberOrNull(record.port);
    if (!targetId || port === null) continue;
    const target = await findDevToolsTargetById([port], targetId, timeoutMs);
    if (target) targets.push(target);
    if (targets.length >= maxInspect) break;
  }
  return targets;
}

async function inspectChatGptComposerPreflight(input: z.infer<typeof chatGptComposerPreflightInputSchema>): Promise<Record<string, unknown>> {
  const result = await executorInspectComposerPreflight({ ports: input.ports, targetId: input.expectedTargetId, timeoutMs: input.timeoutMs });
  const overlay = typeof result.overlay === "object" && result.overlay !== null ? result.overlay as Record<string, unknown> : {};
  const ready = result.ok === true;
  return {
    ok: ready,
    status: String(result.status ?? (ready ? "COMPOSER_PREFLIGHT_READY" : "COMPOSER_PREFLIGHT_BLOCKED")),
    ...result,
    probe: result.probe ?? result,
    next_safe_action: ready ? "submit_allowed" : (overlay.present === true ? "manual_close_or_classify_overlay" : "inspect_composer_state"),
    policy: buildChatGptComposerPreflightPolicy(),
  };
}

async function previewBrowserEmptyPageCleanup(input: z.infer<typeof chatTabCleanupPreviewInputSchema>): Promise<Record<string, unknown>> {
  const result = await cleanupChatGptTabs({
    ports: input.ports,
    dryRun: true,
    confirmCleanup: false,
    maxClose: input.maxClose,
    keepTargetId: input.keepTargetId,
    timeoutMs: input.timeoutMs,
  });
  const candidateCount = Number(result.candidate_count ?? 0);
  const selectedCount = Number(result.selected_count ?? 0);
  return {
    ok: true,
    status: "BROWSER_EMPTY_PAGE_CLEANUP_PREVIEW_READY",
    ports: input.ports,
    empty_page_candidate_count: candidateCount,
    selected_count: selectedCount,
    requested_action_count: selectedCount,
    max_selected_count: input.maxClose,
    executor_tool: "console.write.browser.empty.page.cleanup",
    executor_requires: { dryRun: false, confirmCleanup: true, maxClose: input.maxClose },
    closed_count: 0,
    details_omitted: true,
    policy: buildBrowserEmptyPageCleanupPreviewPolicy(),
  };
}

async function previewDuplicateChatGptTabCleanup(input: z.infer<typeof chatTabCleanupPreviewInputSchema>): Promise<Record<string, unknown>> {
  const inventory = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  const selected = selectDuplicateChatGptTabTargets(inventory, input.maxClose, input.keepTargetId);
  return {
    ok: true,
    status: "CHATGPT_DUPLICATE_TAB_CLEANUP_PREVIEW_READY",
    ports: input.ports,
    duplicate_chat_id_group_count: Number(inventory.duplicate_chat_id_count ?? 0),
    duplicate_tab_candidate_count: selected.candidateCount,
    selected_count: selected.targets.length,
    requested_action_count: selected.targets.length,
    max_selected_count: input.maxClose,
    executor_tool: "console.write.browser.chatgpt.duplicate.tab.cleanup",
    executor_requires: { dryRun: false, confirmCleanup: true, maxClose: input.maxClose },
    closed_count: 0,
    details_omitted: true,
    policy: buildDuplicateChatGptTabCleanupPreviewPolicy(),
  };
}

async function cleanupDuplicateChatGptTabs(input: z.infer<typeof chatTabCleanupInputSchema>): Promise<Record<string, unknown>> {
  const before = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  const selected = selectDuplicateChatGptTabTargets(before, input.maxClose, input.keepTargetId);
  if (input.dryRun || !input.confirmCleanup) {
    return {
      ok: false,
      status: input.dryRun ? "CHATGPT_DUPLICATE_TAB_CLEANUP_DRY_RUN" : "CONFIRM_CLEANUP_REQUIRED",
      dry_run: input.dryRun,
      confirm_cleanup: input.confirmCleanup,
      duplicate_chat_id_group_count: Number(before.duplicate_chat_id_count ?? 0),
      duplicate_tab_candidate_count: selected.candidateCount,
      selected_count: selected.targets.length,
      selected_targets: selected.targets,
      closed_count: 0,
      before,
      policy: buildDuplicateChatGptTabCleanupPolicy(),
    };
  }

  const closed: Array<Record<string, unknown>> = [];
  for (const target of selected.targets) {
    const targetId = getCompactTargetId(target);
    const port = Number(target.port ?? 0);
    if (!targetId || !Number.isInteger(port) || port < 1024) {
      closed.push({ ok: false, status: "TARGET_CLOSE_SKIPPED_INVALID_TARGET", target });
      continue;
    }
    try {
      const liveTarget = await findDevToolsTargetById([port], targetId, input.timeoutMs);
      if (!liveTarget) {
        closed.push({ ok: false, status: "ACTIVE_TAB_GUARD_TARGET_NOT_RESOLVED", target, protected: true });
        continue;
      }
      const activity = await inspectTargetActivity(liveTarget, input.timeoutMs);
      if (activity.protected === true) {
        closed.push({ ok: true, status: "ACTIVE_BROWSER_TAB_PRESERVED", target, activity, closed: false });
        continue;
      }
      const body = await closeDevToolsTarget(port, targetId, input.timeoutMs);
      closed.push({ ok: true, status: "TARGET_CLOSE_REQUESTED", target, body });
    } catch (error) {
      closed.push({ ok: false, status: "TARGET_CLOSE_FAILED", target, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const after = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  return {
    ok: closed.every((item) => item.ok === true),
    status: "CHATGPT_DUPLICATE_TAB_CLEANUP_DONE",
    dry_run: false,
    confirm_cleanup: true,
    duplicate_chat_id_group_count_before: Number(before.duplicate_chat_id_count ?? 0),
    duplicate_tab_candidate_count_before: selected.candidateCount,
    requested_close_count: selected.targets.length,
    closed_count: closed.filter((item) => item.closed === true || item.status === "TARGET_CLOSE_REQUESTED").length,
    duplicate_chat_id_group_count_after: Number(after.duplicate_chat_id_count ?? 0),
    closed,
    before,
    after,
    policy: buildDuplicateChatGptTabCleanupPolicy(),
  };
}

function selectDuplicateChatGptTabTargets(inventory: Record<string, unknown>, maxClose: number, keepTargetId: string | undefined): { candidateCount: number; targets: Array<Record<string, unknown>> } {
  const groups = Array.isArray(inventory.duplicate_chat_ids) ? inventory.duplicate_chat_ids as Array<Record<string, unknown>> : [];
  const candidates: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const targets = Array.isArray(group.targets) ? group.targets as Array<Record<string, unknown>> : [];
    const closable = targets.filter((target) => {
      const targetId = getCompactTargetId(target);
      return Boolean(targetId) && targetId !== keepTargetId;
    });
    if (closable.length === 0) continue;
    const hasExplicitKeeper = targets.some((target) => getCompactTargetId(target) === keepTargetId);
    candidates.push(...(hasExplicitKeeper ? closable : closable.slice(1)));
  }
  return { candidateCount: candidates.length, targets: candidates.slice(0, maxClose) };
}

function getCompactTargetId(target: Record<string, unknown>): string | null {
  const value = target.target_id ?? target.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildChatGptPluginSettingsCleanupPreviewPolicy(): Record<string, unknown> {
  return { scope: "chatgpt_settings_tabs", compatibility_tool_name: "plugin.settings.cleanup", includes_plugins_wildcard_surfaces: true, mutation: false, dry_run: true, active_browser_tab_preserved: true, url_revalidated_before_close: true, confirmation_required_for_execution: true };
}

function buildChatGptPluginSettingsCleanupPolicy(): Record<string, unknown> {
  return { scope: "chatgpt_settings_tabs", compatibility_tool_name: "plugin.settings.cleanup", includes_plugins_wildcard_surfaces: true, mutation: true, dry_run_supported: true, confirm_cleanup_required: true, active_browser_tab_preserved: true, url_revalidated_before_close: true, unrelated_tabs_preserved: true };
}

async function previewChatGptPluginSettingsCleanup(input: z.infer<typeof chatTabCleanupPreviewInputSchema>): Promise<Record<string, unknown>> {
  const inventory = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  const selected = selectChatGptPluginSettingsTargets(inventory, input.maxClose, input.keepTargetId);
  return {
    ok: true,
    status: "CHATGPT_PLUGIN_SETTINGS_CLEANUP_PREVIEW_READY",
    ports: input.ports,
    settings_candidate_count: selected.candidateCount,
    plugin_settings_candidate_count: selected.candidateCount,
    selected_count: selected.targets.length,
    requested_action_count: selected.targets.length,
    max_selected_count: input.maxClose,
    executor_tool: "console.write.browser.chatgpt.plugin.settings.cleanup",
    executor_requires: { dryRun: false, confirmCleanup: true, maxClose: input.maxClose },
    closed_count: 0,
    details_omitted: true,
    policy: buildChatGptPluginSettingsCleanupPreviewPolicy(),
  };
}

async function cleanupChatGptPluginSettingsTabs(input: z.infer<typeof chatTabCleanupInputSchema>): Promise<Record<string, unknown>> {
  const before = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  const selected = selectChatGptPluginSettingsTargets(before, input.maxClose, input.keepTargetId);
  if (input.dryRun || !input.confirmCleanup) {
    return { ok: false, status: input.dryRun ? "CHATGPT_PLUGIN_SETTINGS_CLEANUP_DRY_RUN" : "CONFIRM_CLEANUP_REQUIRED", dry_run: input.dryRun, confirm_cleanup: input.confirmCleanup, plugin_settings_candidate_count: selected.candidateCount, selected_count: selected.targets.length, selected_targets: selected.targets, closed_count: 0, before, policy: buildChatGptPluginSettingsCleanupPolicy() };
  }
  const closed: Array<Record<string, unknown>> = [];
  for (const target of selected.targets) {
    const targetId = getCompactTargetId(target);
    const port = Number(target.port ?? 0);
    if (!targetId || !Number.isInteger(port) || port < 1024) { closed.push({ ok: false, status: "TARGET_CLOSE_SKIPPED_INVALID_TARGET", target }); continue; }
    try {
      const liveTarget = await findDevToolsTargetById([port], targetId, input.timeoutMs);
      if (!liveTarget) { closed.push({ ok: false, status: "ACTIVE_TAB_GUARD_TARGET_NOT_RESOLVED", target, protected: true }); continue; }
      if (!isChatGptSettingsSurfaceUrl(liveTarget.url ?? "")) { closed.push({ ok: false, status: "SETTINGS_TARGET_URL_CHANGED", target: compactChatGptTarget(liveTarget), protected: true }); continue; }
      const activity = await inspectTargetActivity(liveTarget, input.timeoutMs);
      if (activity.protected === true) { closed.push({ ok: true, status: "ACTIVE_BROWSER_TAB_PRESERVED", target, activity, closed: false }); continue; }
      const body = await closeDevToolsTarget(port, targetId, input.timeoutMs);
      closed.push({ ok: true, status: "TARGET_CLOSE_REQUESTED", target, body, closed: true });
    } catch (error) {
      closed.push({ ok: false, status: "TARGET_CLOSE_FAILED", target, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const after = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  const remaining = selectChatGptPluginSettingsTargets(after, 50, input.keepTargetId);
  return { ok: closed.every((item) => item.ok === true), status: "CHATGPT_PLUGIN_SETTINGS_CLEANUP_DONE", dry_run: false, confirm_cleanup: true, settings_candidate_count_before: selected.candidateCount, plugin_settings_candidate_count_before: selected.candidateCount, requested_close_count: selected.targets.length, closed_count: closed.filter((item) => item.closed === true || item.status === "TARGET_CLOSE_REQUESTED").length, preserved_active_count: closed.filter((item) => item.status === "ACTIVE_BROWSER_TAB_PRESERVED").length, settings_candidate_count_after: remaining.candidateCount, plugin_settings_candidate_count_after: remaining.candidateCount, closed, before, after, policy: buildChatGptPluginSettingsCleanupPolicy() };
}

function selectChatGptPluginSettingsTargets(inventory: Record<string, unknown>, maxClose: number, keepTargetId: string | undefined): { candidateCount: number; targets: Array<Record<string, unknown>> } {
  const targets = Array.isArray(inventory.targets) ? inventory.targets as Array<Record<string, unknown>> : [];
  const candidates = targets.filter((target) => {
    const targetId = getCompactTargetId(target);
    const url = typeof target.url === "string" ? target.url : "";
    return Boolean(targetId) && targetId !== keepTargetId && isChatGptSettingsSurfaceUrl(url);
  });
  return { candidateCount: candidates.length, targets: candidates.slice(0, maxClose) };
}

async function previewNoIdChatGptTab(input: z.infer<typeof chatTabCleanupPreviewInputSchema>): Promise<Record<string, unknown>> {
  const inventory = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  const selected = selectNoIdChatGptTabTargets(inventory, input.maxClose, input.keepTargetId);
  return {
    ok: true,
    status: "CHATGPT_NO_ID_TAB_PREVIEW_READY",
    ports: input.ports,
    no_id_tab_candidate_count: selected.candidateCount,
    selected_count: selected.targets.length,
    requested_action_count: selected.targets.length,
    max_selected_count: input.maxClose,
    executor_tool: "console.write.browser.chatgpt.blank.target.prune",
    executor_requires: { dryRun: false, confirmCleanup: true, maxClose: input.maxClose },
    closed_count: 0,
    details_omitted: true,
    policy: buildNoIdChatGptTabPreviewPolicy(),
  };
}

async function closeNoIdChatGptTabs(input: z.infer<typeof chatTabCleanupInputSchema>): Promise<Record<string, unknown>> {
  const before = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  const selected = selectNoIdChatGptTabTargets(before, input.maxClose, input.keepTargetId);
  if (input.dryRun || !input.confirmCleanup) {
    return {
      ok: false,
      status: input.dryRun ? "CHATGPT_NO_ID_TAB_CLOSE_DRY_RUN" : "CONFIRM_CLOSE_REQUIRED",
      dry_run: input.dryRun,
      confirm_cleanup: input.confirmCleanup,
      no_id_tab_candidate_count: selected.candidateCount,
      selected_count: selected.targets.length,
      selected_targets: selected.targets,
      closed_count: 0,
      before,
      policy: buildNoIdChatGptTabClosePolicy(),
    };
  }

  const closed: Array<Record<string, unknown>> = [];
  for (const target of selected.targets) {
    const targetId = getCompactTargetId(target);
    const port = Number(target.port ?? 0);
    if (!targetId || !Number.isInteger(port) || port < 1024) {
      closed.push({ ok: false, status: "TARGET_CLOSE_SKIPPED_INVALID_TARGET", target });
      continue;
    }
    try {
      const liveTarget = await findDevToolsTargetById([port], targetId, input.timeoutMs);
      if (!liveTarget) {
        closed.push({ ok: false, status: "ACTIVE_TAB_GUARD_TARGET_NOT_RESOLVED", target, protected: true });
        continue;
      }
      const activity = await inspectTargetActivity(liveTarget, input.timeoutMs);
      if (activity.protected === true) {
        closed.push({ ok: true, status: "ACTIVE_BROWSER_TAB_PRESERVED", target, activity, closed: false });
        continue;
      }
      const body = await closeDevToolsTarget(port, targetId, input.timeoutMs);
      closed.push({ ok: true, status: "TARGET_CLOSE_REQUESTED", target, body });
    } catch (error) {
      closed.push({ ok: false, status: "TARGET_CLOSE_FAILED", target, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const after = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  const afterSelected = selectNoIdChatGptTabTargets(after, input.maxClose, input.keepTargetId);
  return {
    ok: closed.every((item) => item.ok === true),
    status: "CHATGPT_NO_ID_TAB_CLOSE_DONE",
    dry_run: false,
    confirm_cleanup: true,
    no_id_tab_candidate_count_before: selected.candidateCount,
    requested_close_count: selected.targets.length,
    closed_count: closed.filter((item) => item.closed === true || item.status === "TARGET_CLOSE_REQUESTED").length,
    no_id_tab_candidate_count_after: afterSelected.candidateCount,
    closed,
    before,
    after,
    policy: buildNoIdChatGptTabClosePolicy(),
  };
}

function selectNoIdChatGptTabTargets(inventory: Record<string, unknown>, maxClose: number, keepTargetId: string | undefined): { candidateCount: number; targets: Array<Record<string, unknown>> } {
  const targets = Array.isArray(inventory.targets) ? inventory.targets as Array<Record<string, unknown>> : [];
  const candidates = targets.filter((target) => {
    const targetId = getCompactTargetId(target);
    const chatId = target.chat_id;
    const url = typeof target.url === "string" ? target.url : "";
    return Boolean(targetId)
      && targetId !== keepTargetId
      && (chatId === null || chatId === undefined || chatId === "")
      && isSafeChatGptNoIdTabUrl(url);
  });
  return { candidateCount: candidates.length, targets: candidates.slice(0, maxClose) };
}

function isSafeChatGptNoIdTabUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:"
      && parsed.hostname === "chatgpt.com"
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}

async function cleanupBrowserSessionTargets(input: z.infer<typeof chatTabCleanupInputSchema>): Promise<Record<string, unknown>> {
  try {
    const result = await cleanupChatGptTabs(input);
    return { ...result, status: result.status === "CHATGPT_TAB_CLEANUP_DRY_RUN" ? "BROWSER_SESSION_TARGET_CLEANUP_DRY_RUN" : (result.status === "CHATGPT_TAB_CLEANUP_DONE" ? "BROWSER_SESSION_TARGET_CLEANUP_DONE" : String(result.status ?? "BROWSER_SESSION_TARGET_CLEANUP_BLOCKED")), policy: buildBrowserSessionTargetCleanupPolicy() };
  } catch (error) {
    return { ok: false, status: "BROWSER_SESSION_TARGET_CLEANUP_EXCEPTION", dry_run: input.dryRun, confirm_cleanup: input.confirmCleanup, error: error instanceof Error ? error.message : String(error), policy: buildBrowserSessionTargetCleanupPolicy() };
  }
}

async function cleanupBrowserEmptyPages(input: z.infer<typeof chatTabCleanupInputSchema>): Promise<Record<string, unknown>> {
  const before = await summarizeBrowserEmptyPages(input);
  const requested = Number(before.empty_page_candidate_count ?? 0);
  if (input.dryRun || !input.confirmCleanup) {
    return {
      ok: false,
      status: "CONFIRM_CLEANUP_REQUIRED",
      dry_run: input.dryRun,
      confirm_cleanup: input.confirmCleanup,
      before_empty_count: requested,
      requested_close_count: Math.min(requested, input.maxClose),
      closed_count: 0,
      after_empty_count: requested,
      details_omitted: true,
      policy: buildBrowserEmptyPageCleanupPolicy(),
    };
  }
  const result = await cleanupChatGptTabs(input);
  const after = await summarizeBrowserEmptyPages({ ports: input.ports, timeoutMs: input.timeoutMs });
  return {
    ok: result.ok === true,
    status: result.status === "CHATGPT_TAB_CLEANUP_DONE" ? "BROWSER_EMPTY_PAGE_CLEANUP_DONE" : "BROWSER_EMPTY_PAGE_CLEANUP_REVIEW",
    dry_run: false,
    confirm_cleanup: true,
    before_empty_count: requested,
    requested_close_count: Math.min(requested, input.maxClose),
    closed_count: Number(result["closed_count"] ?? 0),
    after_empty_count: Number(after.empty_page_candidate_count ?? 0),
    details_omitted: true,
    policy: buildBrowserEmptyPageCleanupPolicy(),
  };
}

async function planChatGptChatDelete(input: z.infer<typeof chatDeletePlanInputSchema>): Promise<Record<string, unknown>> {
  const resolved = await resolveChatGptDeleteTarget(input.ports, input.preferredChatId, input.requireChatId, input.timeoutMs);
  return {
    ok: resolved.ok,
    status: resolved.ok ? "CHATGPT_CHAT_DELETE_PLAN_READY" : resolved.status,
    selected: resolved.selected ?? null,
    candidate_count: resolved.candidate_count,
    duplicate_chat_id_count: resolved.duplicate_chat_id_count,
    execute_tool: "console.write.browser.chatgpt.chat.delete.execute",
    execute_requires: resolved.selected?.chat_id ? { expectedChatId: resolved.selected.chat_id, confirmDelete: true } : { expectedChatId: "<chat-id>", confirmDelete: true },
    inventory: resolved.inventory,
    policy: buildChatGptChatDeletePlanPolicy(),
  };
}

async function executeChatGptChatDelete(input: z.infer<typeof chatDeleteExecuteInputSchema>): Promise<Record<string, unknown>> {
  const resolved = await resolveChatGptDeleteTarget(input.ports, input.expectedChatId, true, input.timeoutMs);
  if (!input.confirmDelete) {
    return { ok: false, status: "CONFIRM_CHAT_DELETE_REQUIRED", expected_chat_id: input.expectedChatId, selected: resolved.selected ?? null, policy: buildChatGptChatDeleteExecutePolicy() };
  }
  if (!resolved.ok || !resolved.selected) {
    return { ok: false, status: resolved.status, expected_chat_id: input.expectedChatId, resolver: resolved, policy: buildChatGptChatDeleteExecutePolicy() };
  }
  if (resolved.selected.chat_id !== input.expectedChatId) {
    return { ok: false, status: "CHAT_DELETE_CHAT_ID_MISMATCH", expected_chat_id: input.expectedChatId, selected: resolved.selected, policy: buildChatGptChatDeleteExecutePolicy() };
  }
  const liveTarget = await findBestChatGptTargetForChatId(input.ports, input.expectedChatId, input.timeoutMs);
  if (!liveTarget) return { ok: false, status: "CHAT_DELETE_TARGET_NOT_FOUND", expected_chat_id: input.expectedChatId, selected: resolved.selected, policy: buildChatGptChatDeleteExecutePolicy() };
  const webSocketUrl = liveTarget.web_socket_debugger_url ?? liveTarget.webSocketDebuggerUrl ?? null;
  if (!webSocketUrl) return { ok: false, status: "CHAT_DELETE_NEED_DEVTOOLS_WEBSOCKET", selected: compactChatGptTarget(liveTarget), policy: buildChatGptChatDeleteExecutePolicy() };

  const deleteResult = await safeEvaluateInTarget(webSocketUrl, buildDeleteConversationExpression(input.expectedChatId, input.closeTarget), input.timeoutMs, "CHAT_DELETE_EVALUATION_FAILED");
  const deleteOk = Boolean((deleteResult as { ok?: unknown }).ok);
  const after = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  const stillVisible = (after.targets as Array<Record<string, unknown>>).some((target) => target.chat_id === input.expectedChatId);
  return {
    ok: deleteOk && !stillVisible,
    status: deleteOk && !stillVisible ? "CHATGPT_CHAT_DELETE_DONE" : "CHATGPT_CHAT_DELETE_NEEDS_REVIEW",
    expected_chat_id: input.expectedChatId,
    selected: resolved.selected,
    delete: deleteResult,
    after,
    still_visible: stillVisible,
    policy: buildChatGptChatDeleteExecutePolicy(),
  };
}

function planBrowserConnectorSchemaRefresh(input: z.infer<typeof browserConnectorRefreshPlanInputSchema>): Record<string, unknown> {
  return {
    ok: true,
    status: "BROWSER_SCHEMA_REFRESH_PLAN_READY",
    plan: {
      stage: "refresh_connector_schema",
      browser_target: "ChatGPT connector settings",
      connector_name: "console-mcp",
      refresh_script: "tool/chatgpt-connector-refresh.mjs",
      execute_tool: "console.write.browser.schema.refresh.execute",
      execute_requires: { confirmRefresh: true, timeoutMs: input.timeoutMs },
      will_click: ["Refresh"],
      will_reconnect: false,
      will_disconnect: false,
      will_restart_runtime: false,
    },
    policy: buildBrowserConnectorSchemaRefreshPlanPolicy(),
  };
}

async function refreshChatGptConnectorSchema(input: z.infer<typeof chatGptConnectorRefreshInputSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmRefresh) {
    return { ok: false, status: "CONFIRM_CONNECTOR_REFRESH_REQUIRED", requires_user_action: true, next_action: "confirm connector refresh after runtime rebuild/restart", policy: buildChatGptConnectorRefreshPolicy() };
  }
  const script = path.resolve(process.cwd(), "tool", "chatgpt-connector-refresh.mjs");
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--timeout-sec", String(Math.max(5, Math.ceil(input.timeoutMs / 1000)))], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, status: "CONNECTOR_REFRESH_TIMEOUT", error: `Connector refresh exceeded ${input.timeoutMs} ms.`, policy: buildChatGptConnectorRefreshPolicy() });
    }, input.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, status: "CONNECTOR_REFRESH_LAUNCH_FAILED", error: error.message, policy: buildChatGptConnectorRefreshPolicy() });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      let parsed: Record<string, unknown> | null = null;
      try { parsed = output ? JSON.parse(output) as Record<string, unknown> : null; } catch {}
      resolve({
        ok: code === 0 && parsed?.ok === true,
        status: code === 0 ? String(parsed?.status ?? "CONNECTOR_REFRESHED") : "CONNECTOR_REFRESH_FAILED",
        exit_code: code,
        refresh: parsed ?? { raw_output: output.slice(0, 12000) },
        stderr: errorText ? errorText.slice(0, 4000) : null,
        policy: buildChatGptConnectorRefreshPolicy(),
      });
    });
  });
}

async function resolveChatGptDeleteTarget(ports: number[], preferredChatId: string | undefined, requireChatId: boolean, timeoutMs: number): Promise<Record<string, any>> {
  const inventory = await collectChatGptTabInventory(ports, timeoutMs);
  const targets = (inventory.targets as Array<Record<string, unknown>>).filter((target) => typeof target.chat_id === "string" && target.chat_id.length > 0);
  const duplicateCount = Number(inventory.duplicate_chat_id_count ?? 0);
  if (preferredChatId) {
    const selected = await findBestChatGptTargetForChatId(ports, preferredChatId, timeoutMs);
    if (!selected) return { ok: false, status: "CHAT_DELETE_TARGET_NOT_FOUND", candidate_count: targets.length, duplicate_chat_id_count: duplicateCount, inventory };
    return { ok: true, status: "CHAT_DELETE_TARGET_READY", selected: compactChatGptTarget(selected), candidate_count: targets.length, duplicate_chat_id_count: duplicateCount, inventory };
  }
  const uniqueChatIds = [...new Set(targets.map((target) => String(target.chat_id)).filter(Boolean))];
  if (requireChatId && uniqueChatIds.length !== 1) {
    return { ok: false, status: uniqueChatIds.length === 0 ? "CHAT_DELETE_CHAT_ID_MISSING" : "CHAT_DELETE_AMBIGUOUS_CHAT_ID", candidate_count: targets.length, unique_chat_id_count: uniqueChatIds.length, duplicate_chat_id_count: duplicateCount, inventory };
  }
  const chatId = uniqueChatIds[0] ?? null;
  if (!chatId) return { ok: false, status: "CHAT_DELETE_CHAT_ID_MISSING", candidate_count: targets.length, duplicate_chat_id_count: duplicateCount, inventory };
  const selected = await findBestChatGptTargetForChatId(ports, chatId, timeoutMs);
  if (!selected) return { ok: false, status: "CHAT_DELETE_TARGET_NOT_FOUND", candidate_count: targets.length, duplicate_chat_id_count: duplicateCount, inventory };
  return { ok: true, status: "CHAT_DELETE_TARGET_READY", selected: compactChatGptTarget(selected), candidate_count: targets.length, duplicate_chat_id_count: duplicateCount, inventory };
}

export async function openChatGptChat(policy: ConsolePolicy, input: z.infer<typeof chatOpenInputSchema>, reuseOptions: ChatGptReuseOptions = {}): Promise<Record<string, unknown>> {
  const targetUrl = normalizeChatGptUrl(input.url);
  if (!input.confirmOpen) {
    return { ok: false, status: "CONFIRM_OPEN_REQUIRED", target_url: targetUrl, will_submit: false, policy: buildChatOpenPolicy() };
  }

  const attempts: Array<Record<string, unknown>> = [];
  const inventory = await collectChatGptTabInventory(input.ports, input.timeoutMs);
  const emptyHomeCount = Number(inventory.empty_home_count ?? 0);
  const chatTargetCount = Number(inventory.chat_target_count ?? 0);
  if (isChatGptHomeUrl(targetUrl) && emptyHomeCount > CHATGPT_EMPTY_HOME_BLOCK_THRESHOLD && chatTargetCount < 1) {
    return {
      ok: false,
      status: "CHATGPT_BROWSER_POOL_NOT_READY",
      target_url: targetUrl,
      empty_home_count: emptyHomeCount,
      chat_target_count: chatTargetCount,
      empty_home_block_threshold: CHATGPT_EMPTY_HOME_BLOCK_THRESHOLD,
      recommended_action: "prune_blank_targets_or_restart_visible_browser",
      inventory,
      attempts,
      will_submit: false,
      policy: buildChatOpenPolicy(),
    };
  }
  const reusable = reuseOptions.forceCreateNew === true
    ? null
    : await findReusableChatGptTarget(input.ports, targetUrl, input.timeoutMs, reuseOptions);
  if (reusable) {
    if (input.activate && reusable.id) await activateDevToolsTarget(reusable.port, reusable.id, input.timeoutMs);
    const selected = reusable.chat_id ? await findBestChatGptTargetForChatId(input.ports, reusable.chat_id, input.timeoutMs) ?? reusable : reusable;
    return { ok: true, status: "CHATGPT_DOCUMENT_REUSED", selected, opened_target: reusable, chat_id: selected.chat_id, current_url: selected.url ?? targetUrl, port: selected.port, attempts, will_submit: false, reused_existing_target: true, title_prefix: { ok: true, status: "TITLE_PREFIX_NOT_ATTEMPTED", next_tool: "console.write.browser.session.title.prefix" }, policy: buildChatOpenPolicy() };
  }

  for (const port of [...new Set(input.ports)]) {
    try {
      const created = await createDevToolsTarget(port, targetUrl, input.timeoutMs);
      if (!created.id) {
        attempts.push({ port, ok: false, status: "TARGET_ID_MISSING", created });
        continue;
      }
      if (input.activate) {
        await activateDevToolsTarget(port, created.id, input.timeoutMs);
      }
      const ready = await resolveChatGptDocumentTarget(port, created.id, input.timeoutMs);
      if (ready === null) {
        attempts.push({ port, ok: false, status: "CHATGPT_DOCUMENT_NOT_READY", target_id: created.id });
        continue;
      }
      const selected = ready.chat_id ? await findBestChatGptTargetForChatId(input.ports, ready.chat_id, input.timeoutMs) ?? ready : ready;
      return { ok: true, status: "CHATGPT_DOCUMENT_READY", selected, opened_target: ready, chat_id: selected.chat_id, current_url: selected.url ?? targetUrl, port: selected.port, attempts, title_prefix: { ok: true, status: "TITLE_PREFIX_NOT_ATTEMPTED", next_tool: "console.write.browser.session.title.prefix" }, will_submit: false, policy: buildChatOpenPolicy() };
    } catch (error) {
      attempts.push({ port, ok: false, status: "OPEN_FAILED", error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { ok: false, status: "NEED_DEVTOOLS_BROWSER", target_url: targetUrl, attempts, will_submit: false, policy: buildChatOpenPolicy() };
}

export async function draftBrowserSessionInput(input: z.infer<typeof browserSessionInputDraftSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmDraft) {
    return { ok: false, status: "CONFIRM_INPUT_DRAFT_REQUIRED", policy: buildBrowserSessionInputDraftPolicy() };
  }
  const result = await executorDraftInput({
    ports: input.ports,
    targetId: input.expectedTargetId,
    prompt: input.draftText,
    allowOverwrite: input.allowOverwrite,
    expectedExistingHash: input.expectedExistingHash,
    timeoutMs: input.timeoutMs,
  });
  return { ...result, current_url: (result.selected as { url?: unknown } | undefined)?.url ?? null, policy: buildBrowserSessionInputDraftPolicy() };
}

function classifyInputDraftBlocked(value: unknown): { reason: string; detail: string | null } {
  const draft = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const status = typeof draft.status === "string" ? draft.status : "UNKNOWN";
  const detail = typeof draft.error === "string" ? draft.error : (typeof draft.message === "string" ? draft.message : null);
  const focus = asRecord(draft.focus) ?? asRecord(asRecord(draft.draft)?.focus);
  const href = stringOrNull(focus?.href) ?? stringOrNull(draft.href) ?? stringOrNull(asRecord(draft.draft)?.href);
  if (href === "about:blank") return { reason: "draft_blocked_about_blank_dom_not_ready", detail };
  switch (status) {
    case "COMPOSER_NOT_READY": return { reason: "composer_not_ready", detail };
    case "COMPOSER_NOT_EMPTY": return { reason: "overwrite_required", detail };
    case "DRAFT_WRITE_NOT_APPLIED": return { reason: "draft_write_not_applied", detail };
    case "INPUT_DRAFT_EVALUATION_FAILED": return { reason: "draft_evaluation_failed", detail };
    default: return { reason: "draft_blocked_" + status.toLowerCase(), detail };
  }
}

export async function submitBrowserSession(input: z.infer<typeof browserSessionSubmitSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmSubmit) {
    return { ok: false, status: "CONFIRM_SUBMIT_REQUIRED", policy: buildBrowserSessionSubmitPolicy() };
  }
  const result = await executorSubmitDraft({
    ports: input.ports,
    targetId: input.expectedTargetId,
    confirmSubmit: true,
    timeoutMs: input.timeoutMs,
  });
  return { ...result, title_prefix_next_tool: "console.write.browser.session.title.prefix", policy: buildBrowserSessionSubmitPolicy() };
}

async function createSubmitChatGptChat(policy: ConsolePolicy, input: z.infer<typeof chatCreateSendInputSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmSend) {
    return { ok: false, status: "CONFIRM_CHAT_CREATE_SEND_REQUIRED", will_submit: true, policy: buildPromptSendPolicy() };
  }
  void policy;
  const result = await executorSendPrompt({
    ports: input.ports,
    prompt: input.prompt,
    allowOverwrite: input.allowOverwrite,
    allowGuestRootSession: input.allowGuestRootSession,
    confirmSend: true,
    timeoutMs: Math.min(input.timeoutMs, 30000),
  });
  const chatId = typeof result.chat_id === "string" ? result.chat_id : null;
  const targetId = typeof result.target_id === "string" ? result.target_id : null;
  return {
    ...result,
    taskId: input.taskId ?? null,
    promptId: input.promptId ?? null,
    component: input.component ?? null,
    chatId,
    url: result.after_url ?? result.before_url ?? null,
    targetId,
    sentAt: result.ok === true ? new Date().toISOString() : null,
    submitted: result.ok === true,
    nextAction: result.ok === true ? null : (result.status === "CHATGPT_SEND_SUBMIT_UNCONFIRMED" ? "inspect exact target composer/overlay/network state" : result.status),
    policy: buildPromptSendPolicy(),
  };
}

async function runBrowserSessionCmcpGo(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof browserSessionCmcpGoSchema>): Promise<Record<string, unknown>> {
  const workspacePath = input.workspacePath ?? inferCmcpGoWorkspacePath(input.componentName, input.rawCommand);
  const componentName = input.componentName ?? inferCmcpGoComponentName(workspacePath, input.rawCommand);
  const plan = buildChatGptEntrypointPlan({
    rawPrompt: input.rawCommand,
    workspacePath,
    componentName,
    taskPreset: input.taskPreset,
    maxAutoIterations: input.maxAutoIterations,
  });
  const plannedPrompt = typeof plan.enrichedPrompt === "string" ? plan.enrichedPrompt : "";
  const enrichedPrompt = input.promptMode === "raw" ? input.rawCommand : plannedPrompt;
  const enrichedPromptHash = enrichedPrompt.length > 0 ? hashChatGptDraftText(enrichedPrompt) : null;
  const enrichmentGate = input.promptMode === "raw" ? { ok: true, status: "CMCP_GO_RAW_PROMPT_SELECTED" } : verifyCmcpGoEnrichment(input.rawCommand, plan, enrichedPrompt);

  if (!input.confirmGo || !enrichmentGate.ok) {
    return {
      ok: false,
      status: input.confirmGo ? enrichmentGate.status : "CONFIRM_CMCP_GO_REQUIRED",
      workspace_path: workspacePath,
      component_name: componentName,
      plan: summarizeCmcpGoPlan(plan, enrichedPrompt, enrichedPromptHash),
      enrichment_gate: enrichmentGate,
      policy: buildBrowserSessionCmcpGoPolicy(),
    };
  }

  if (input.executorMode === "browser") {
    return await executeBrowserSessionCmcpGo(policy, baseDir, input, workspacePath, componentName, plan, enrichedPrompt, enrichedPromptHash);
  }
  return await executeEngineBackedCmcpGo(policy, baseDir, input, workspacePath, componentName, plan, enrichedPrompt, enrichedPromptHash);
}

async function executeEngineBackedCmcpGo(
  policy: ConsolePolicy,
  baseDir: string,
  input: z.infer<typeof browserSessionCmcpGoSchema>,
  workspacePath: string,
  componentName: string,
  plan: Record<string, unknown>,
  enrichedPrompt: string,
  enrichedPromptHash: string | null,
): Promise<Record<string, unknown>> {
  const engineRoot = assertAllowedRoot(path.resolve(baseDir), policy.allowedRoots);
  const enginePaths = createEnginePaths(engineRoot);
  const enqueue = await enqueueTask(enginePaths, componentName, true, "mcp", workspacePath);
  const taskId = typeof enqueue.task_id === "string" ? enqueue.task_id : null;
  const specification = taskId && enqueue.ok === true
    ? await recordEngineExecutionSpecification(enginePaths, taskId, { content: enrichedPrompt, sourcePrompt: input.rawCommand, templateVersion: "repo_rc_implementation_v1" })
    : null;
  const authorization = taskId && specification?.ok === true
    ? await authorizeEngineTaskExecution(enginePaths, taskId, { authorizedBy: "go", maxAutoIterations: input.maxAutoIterations })
    : { ok: false, status: taskId ? "CMCP_GO_ENGINE_AUTHORIZATION_SKIPPED_SPECIFICATION_BLOCKED" : "CMCP_GO_ENGINE_AUTHORIZATION_SKIPPED_NO_TASK_ID" };

  const loop = enqueue.ok === true && taskId && authorization.ok === true
    ? await runWorkerLoop(enginePaths, { taskId, stopOnIdle: true, stopOnWaitingUser: true })
    : null;
  const dispatch = enqueue.ok === true && taskId ? await maybeDispatchEngineCycleRounds(policy, baseDir, enginePaths, taskId, authorization, input) : null;
  const dispatchRequired = input.manageLoop !== false && authorization.ok === true;
  const dispatchOk = !dispatchRequired || dispatch?.ok === true;
  return await finalizeCmcpGoResult(policy, {
    ok: enqueue.ok === true && specification?.ok === true && dispatchOk,
    status: enqueue.ok !== true
      ? "CMCP_GO_ENGINE_ENQUEUE_BLOCKED"
      : (specification?.ok !== true
        ? "CMCP_GO_ENGINE_SPECIFICATION_BLOCKED"
        : (dispatchRequired && dispatch?.ok !== true ? "CMCP_GO_ENGINE_CYCLE_BLOCKED" : "CMCP_GO_ENGINE_QUEUED")),
    workspace_path: workspacePath,
    component_name: componentName,
    plan: summarizeCmcpGoPlan(plan, enrichedPrompt, enrichedPromptHash),
    engine: { enqueue, specification, loop, run_n: dispatch, max_ticks: null, tick_limit: "task_state" },
    browser_execution: { ok: true, status: "BROWSER_EXECUTION_NOT_USED_ENGINE_MIGRATION", opened: false, drafted: false, submitted: false },
    policy: buildBrowserSessionCmcpGoPolicy(),
  });
}

// Pure gating decision for the automatic post-"go" round dispatch, split out from
// maybeDispatchEngineCycleRounds so it can be unit-tested without a live engine/browser
// executor: given the task record workerTick left behind, decide whether the phase plan has
// actually reached done/dispatch-ready with an authorized max_auto_iterations, and if so what
// maxRounds the round-driving loop should use.
export function resolveCmcpGoAutoDispatch(task: Record<string, unknown>): { dispatch: true; maxRounds: number } | { dispatch: false; status: "ENGINE_CYCLE_RUN_N_DISPATCH_SKIPPED"; task_status: unknown; execution_authorized: boolean; max_auto_iterations: number | null } {
  const maxAutoIterations = typeof task.max_auto_iterations === "number" ? task.max_auto_iterations : null;
  if (task.status !== "done" || task.execution_authorized !== true || !maxAutoIterations || maxAutoIterations <= 0) {
    return { dispatch: false, status: "ENGINE_CYCLE_RUN_N_DISPATCH_SKIPPED", task_status: task.status ?? null, execution_authorized: task.execution_authorized === true, max_auto_iterations: maxAutoIterations };
  }
  return { dispatch: true, maxRounds: maxAutoIterations };
}

// After "go" authorizes execution and the local phase plan (workerTick's REPO_RC_PHASE_PLAN, no
// browser calls) reaches task_phase_plan_complete_dispatch_ready, this drives the real ChatGPT
// round-trip loop (chat_bind..reply_submit) up to max_auto_iterations rounds automatically —
// the same runEngineCycleRounds implementation console.write.engine.cycle.run_n calls, so
// orphan-detection and stage blocking apply here too. Gated by manageLoop so callers that only
// want the phase plan prepared (e.g. cmcp prepare without go) can opt out.
async function maybeDispatchEngineCycleRounds(
  policy: ConsolePolicy,
  baseDir: string,
  enginePaths: EnginePaths,
  taskId: string,
  authorization: Record<string, unknown>,
  input: z.infer<typeof browserSessionCmcpGoSchema>,
): Promise<Record<string, unknown> | null> {
  if (authorization.ok !== true || input.manageLoop === false) return null;
  const status = await getEngineTaskStatus(enginePaths, taskId);
  const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
  const decision = resolveCmcpGoAutoDispatch(task);
  if (decision.dispatch !== true) {
    return { ok: false, status: decision.status, task_status: decision.task_status, execution_authorized: decision.execution_authorized, max_auto_iterations: decision.max_auto_iterations };
  }
  return await runEngineCycleRounds(enginePaths, {
    policy,
    baseDir,
    ports: input.ports,
    url: input.url,
    activate: input.activate,
    allowOverwrite: input.allowOverwrite,
    forceCreateNewOnInitialBind: true,
    maxMessages: 30,
    timeoutMs: input.timeoutMs,
    readinessProfile: "rc_gate",
    gatewayMaxOutputTokens: 1200,
    gatewayTemperature: 0.1,
    gatewayTimeoutMs: 60000,
    gatewayRaw: false,
  }, { taskId, maxRounds: decision.maxRounds, maxStepsPerRound: 8, stopOnBlocked: true, stopOnNotReady: true });
}

async function executeBrowserSessionCmcpGo(
  policy: ConsolePolicy,
  baseDir: string,
  input: z.infer<typeof browserSessionCmcpGoSchema>,
  workspacePath: string,
  componentName: string,
  plan: Record<string, unknown>,
  enrichedPrompt: string,
  enrichedPromptHash: string | null,
): Promise<Record<string, unknown>> {
  const skippedReusableTargets: Array<Record<string, unknown>> = [];
  const preflight = await buildCmcpGoBrowserPreflight(input.ports, input.timeoutMs);
  if (preflight.ok !== true) {
    return await finalizeCmcpGoResult(policy, { ok: false, status: "CMCP_GO_PREFLIGHT_BLOCKED", workspace_path: workspacePath, component_name: componentName, plan: summarizeCmcpGoPlan(plan, enrichedPrompt, enrichedPromptHash), preflight, skipped_reusable_targets: skippedReusableTargets, policy: buildBrowserSessionCmcpGoPolicy() });
  }
  const opened = await openChatGptChat(policy, {
    ports: input.ports,
    url: input.url,
    activate: input.activate,
    confirmOpen: true,
    timeoutMs: input.timeoutMs,
  }, { requireEmptyHomeComposer: !input.allowOverwrite, skippedTargets: skippedReusableTargets, forceCreateNew: true });
  const openedTarget = opened.selected as OpenedChatGptTarget | undefined;
  const expectedTargetId = typeof openedTarget?.id === "string" ? openedTarget.id : null;
  if (opened.ok !== true || expectedTargetId === null || enrichedPromptHash === null) {
    return await finalizeCmcpGoResult(policy, { ok: false, status: "CMCP_GO_OPEN_BLOCKED", workspace_path: workspacePath, component_name: componentName, plan: summarizeCmcpGoPlan(plan, enrichedPrompt, enrichedPromptHash), opened, skipped_reusable_targets: skippedReusableTargets, policy: buildBrowserSessionCmcpGoPolicy() });
  }

  const draftPreflight = await waitForCmcpGoComposerHydration(input.ports, expectedTargetId, input.timeoutMs);
  if (!isCmcpGoComposerPreflightReady(draftPreflight)) {
    const blocked = buildCmcpGoComposerNotReadyBlocked(opened, draftPreflight, expectedTargetId);
    return await finalizeCmcpGoResult(policy, {
      ok: false,
      status: "CMCP_GO_DRAFT_BLOCKED",
      workspace_path: workspacePath,
      component_name: componentName,
      plan: summarizeCmcpGoPlan(plan, enrichedPrompt, enrichedPromptHash),
      opened,
      draft_preflight: draftPreflight,
      draft_blocked: blocked,
      skipped_reusable_targets: skippedReusableTargets,
      policy: buildBrowserSessionCmcpGoPolicy(),
    });
  }

  let drafted = await draftBrowserSessionInput({ ports: input.ports, expectedTargetId, draftText: enrichedPrompt, allowOverwrite: input.allowOverwrite, confirmDraft: true, timeoutMs: input.timeoutMs });
  let retryDraftPreflight: Record<string, unknown> | null = null;
  if (drafted.ok !== true) {
    retryDraftPreflight = await inspectChatGptComposerPreflight({ ports: input.ports, expectedTargetId, timeoutMs: Math.min(input.timeoutMs, 10000) });
    const composer = asRecord(retryDraftPreflight.composer);
    const canRetry = retryDraftPreflight.ok === true && (composer?.textLength === 0 || composer?.textLength === null || composer?.textLength === undefined);
    if (canRetry) {
      await delay(500);
      drafted = await draftBrowserSessionInput({ ports: input.ports, expectedTargetId, draftText: enrichedPrompt, allowOverwrite: input.allowOverwrite, confirmDraft: true, timeoutMs: Math.min(Math.max(input.timeoutMs, 10000), 30000) });
    }
  }
  if (drafted.ok !== true) {
    return await finalizeCmcpGoResult(policy, { ok: false, status: "CMCP_GO_DRAFT_BLOCKED", workspace_path: workspacePath, component_name: componentName, plan: summarizeCmcpGoPlan(plan, enrichedPrompt, enrichedPromptHash), opened, drafted, draft_preflight: retryDraftPreflight ?? draftPreflight, draft_blocked: classifyInputDraftBlocked(drafted), skipped_reusable_targets: skippedReusableTargets, policy: buildBrowserSessionCmcpGoPolicy() });
  }

  const rateLimit = await waitForChatGptRateLimitToClear({ ports: input.ports, expectedTargetId, timeoutMs: input.timeoutMs, maxAttempts: 3, pollMs: 5000 });
  if (rateLimit.detected === true) {
    const dismissal = await dismissChatGptRateLimit({ ports: input.ports, expectedTargetId, confirmDismiss: true, timeoutMs: input.timeoutMs });
    const retryAfterMs = numberOrNull(dismissal.retry_after_ms) ?? numberOrNull(rateLimit.retry_after_ms) ?? 90000;
    return await finalizeCmcpGoResult(policy, { ok: false, status: "CMCP_GO_DRAFTED_BUT_BLOCKED_RATE_LIMIT", workspace_path: workspacePath, component_name: componentName, plan: summarizeCmcpGoPlan(plan, enrichedPrompt, enrichedPromptHash), opened, drafted, rate_limit: rateLimit, rate_limit_dismissal: dismissal, submitted: { ok: false, status: "SUBMIT_SKIPPED_RATE_LIMIT", submitted: false }, recommended_retry_after_ms: retryAfterMs, cooldown_until: new Date(Date.now() + retryAfterMs).toISOString(), skipped_reusable_targets: skippedReusableTargets, policy: buildBrowserSessionCmcpGoPolicy() });
  }

  const sent = await submitBrowserSession({ ports: input.ports, expectedTargetId, expectedDraftHash: enrichedPromptHash, expectedDraftLength: enrichedPrompt.length, confirmSubmit: true, timeoutMs: input.timeoutMs });
  if (sent.ok !== true) {
    return await finalizeCmcpGoResult(policy, { ok: false, status: "CMCP_GO_SUBMIT_BLOCKED", workspace_path: workspacePath, component_name: componentName, plan: summarizeCmcpGoPlan(plan, enrichedPrompt, enrichedPromptHash), opened, drafted, submitted: sent, skipped_reusable_targets: skippedReusableTargets, policy: buildBrowserSessionCmcpGoPolicy() });
  }

  const submittedTarget = await resolveChatGptDocumentTargetWithChatId(openedTarget!.port, expectedTargetId, input.timeoutMs);
  const chatId = submittedTarget?.chat_id ?? submittedTarget?.runtime_chat_id ?? null;
  if (!chatId) {
    return await finalizeCmcpGoResult(policy, { ok: false, status: "CMCP_GO_SUBMITTED_CHAT_ID_MISSING", workspace_path: workspacePath, component_name: componentName, plan: summarizeCmcpGoPlan(plan, enrichedPrompt, enrichedPromptHash), opened, drafted, submitted: sent, selected_after_submit: submittedTarget, skipped_reusable_targets: skippedReusableTargets, policy: buildBrowserSessionCmcpGoPolicy() });
  }

  const daemon = await startChatGptRunLoopDaemon(policy, baseDir, {
    workspacePath,
    checkNames: [],
    ports: input.ports,
    preferredChatId: chatId,
    requireChatId: true,
    maxMessages: 30,
    timeoutMs: Math.min(input.timeoutMs, 10000),
    phase: "reply_watch",
    taskClass: "repo_rc_implementation",
    iteration: 0,
    maxIterations: input.maxAutoIterations,
    attempt: 0,
    executePreAsk: true,
    gatewayAskMode: "blocked_only",
    gatewayMaxOutputTokens: 1200,
    gatewayTemperature: 0.1,
    gatewayTimeoutMs: 60000,
    maxAutoIterations: input.maxAutoIterations,
    maxElapsedMs: 7200000,
    pollMs: 15000,
    minWaitMs: 3000,
    maxWaitMs: 30000,
    stopOnReturnToChat: false,
    stopOnPreAskExecuted: false,
    runId: deriveEntrypointRunId(componentName, workspacePath, chatId),
    replaceExisting: true,
  });

  return await finalizeCmcpGoResult(policy, { ok: daemon.ok === true, status: daemon.ok === true ? "CMCP_GO_LOOP_STARTED" : "CMCP_GO_SUBMITTED_DAEMON_BLOCKED", workspace_path: workspacePath, component_name: componentName, chat_id: chatId, plan: summarizeCmcpGoPlan(plan, enrichedPrompt, enrichedPromptHash), opened, drafted, submitted: sent, selected_after_submit: submittedTarget, daemon, skipped_reusable_targets: skippedReusableTargets, policy: buildBrowserSessionCmcpGoPolicy() });
}

async function waitForCmcpGoComposerHydration(ports: number[], expectedTargetId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const maxWaitMs = Math.max(500, Math.min(timeoutMs, 30000));
  const deadline = Date.now() + maxWaitMs;
  const attempts: Array<Record<string, unknown>> = [];
  let last: Record<string, unknown> | null = null;
  while (Date.now() <= deadline) {
    last = await inspectChatGptComposerPreflight({ ports, expectedTargetId, timeoutMs: Math.min(timeoutMs, 5000) });
    attempts.push(compactCmcpGoComposerPreflight(last));
    if (isCmcpGoComposerPreflightReady(last)) {
      return { ...last, hydration: { ok: true, status: "CMCP_GO_COMPOSER_HYDRATED", attempts: attempts.length, maxWaitMs, pollMs: 750, history: attempts } };
    }
    await delay(Math.min(1000, Math.max(500, Math.min(deadline - Date.now(), 750))));
  }
  return { ...(last ?? { ok: false, status: "COMPOSER_PREFLIGHT_NOT_RUN" }), hydration: { ok: false, status: "CMCP_GO_COMPOSER_HYDRATION_TIMEOUT", attempts: attempts.length, maxWaitMs, pollMs: 750, history: attempts } };
}

function isCmcpGoComposerPreflightReady(preflight: Record<string, unknown> | null): boolean {
  if (!preflight) return false;
  const status = stringOrNull(preflight.status);
  const focus = extractCmcpGoPreflightFocus(preflight);
  const composer = asRecord(preflight.composer) ?? asRecord(asRecord(preflight.probe)?.composer);
  const candidateCount = numberOrNull(composer?.candidateCount) ?? numberOrNull(preflight.candidateCount) ?? numberOrNull(focus.candidateCount);
  if (focus.href === "about:blank") return false;
  if (candidateCount !== null && candidateCount <= 0) return false;
  if (status === "COMPOSER_NOT_READY" || status === "COMPOSER_PREFLIGHT_NOT_READY") return false;
  return preflight.ok === true || status === "COMPOSER_PREFLIGHT_READY" || status === "COMPOSER_READY";
}

function compactCmcpGoComposerPreflight(preflight: Record<string, unknown>): Record<string, unknown> {
  const focus = extractCmcpGoPreflightFocus(preflight);
  return {
    ok: preflight.ok === true,
    status: stringOrNull(preflight.status),
    href: focus.href,
    focus_status: focus.status,
    candidateCount: focus.candidateCount,
  };
}

function extractCmcpGoPreflightFocus(preflight: Record<string, unknown> | null): { href: string | null; status: string | null; candidateCount: number | null } {
  const probe = asRecord(preflight?.probe);
  const focus = asRecord(preflight?.focus) ?? asRecord(probe?.focus);
  const composer = asRecord(preflight?.composer) ?? asRecord(probe?.composer);
  return {
    href: stringOrNull(focus?.href) ?? stringOrNull(preflight?.href) ?? stringOrNull(probe?.href),
    status: stringOrNull(focus?.status) ?? stringOrNull(preflight?.status) ?? stringOrNull(probe?.status),
    candidateCount: numberOrNull(focus?.candidateCount) ?? numberOrNull(composer?.candidateCount) ?? numberOrNull(preflight?.candidateCount) ?? numberOrNull(probe?.candidateCount),
  };
}

function buildCmcpGoComposerNotReadyBlocked(opened: Record<string, unknown>, draftPreflight: Record<string, unknown>, expectedTargetId: string): Record<string, unknown> {
  const selected = asRecord(opened.selected);
  const focus = extractCmcpGoPreflightFocus(draftPreflight);
  return {
    reason: "composer_not_ready_after_open",
    diagnostic: focus.href === "about:blank" ? "about_blank_composer_not_ready_after_open_hydration" : "composer_not_ready_after_open_hydration",
    expectedTargetId,
    selected: { url: stringOrNull(selected?.url) },
    focus: { href: focus.href, status: focus.status },
    selected_url: stringOrNull(selected?.url),
    focus_href: focus.href,
    focus_status: focus.status,
    candidateCount: focus.candidateCount,
  };
}

async function finalizeCmcpGoResult(policy: ConsolePolicy, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  const trace = buildCmcpGoTraceRecord(result);
  await recordCmcpGoTrace(policy.transcriptDir, trace).catch(() => undefined);
  return { ...result, cmcp_go_trace: trace };
}

function buildCmcpGoTraceRecord(result: Record<string, unknown>): ReturnType<typeof buildCmcpGoTraceRecordShape> {
  return buildCmcpGoTraceRecordShape(result);
}

function buildCmcpGoTraceRecordShape(result: Record<string, unknown>) {
  const plan = asRecord(result.plan);
  const opened = asRecord(result.opened);
  const openedSelected = asRecord(opened?.selected);
  const drafted = asRecord(result.drafted);
  const draft = asRecord(drafted?.draft);
  const submittedRecord = asRecord(result.submitted);
  const submit = asRecord(submittedRecord?.submit);
  const rateLimit = asRecord(result.rate_limit);
  const preflight = asRecord(result.preflight);
  const skipped = Array.isArray(result.skipped_reusable_targets) ? result.skipped_reusable_targets : [];
  return {
    timestamp: new Date().toISOString(),
    ok: result.ok === true,
    status: stringOrNull(result.status) ?? "UNKNOWN",
    workspace_path: stringOrNull(result.workspace_path),
    component_name: stringOrNull(result.component_name),
    plan_status: stringOrNull(plan?.status),
    enriched_prompt_hash: stringOrNull(plan?.enriched_prompt_hash),
    enriched_prompt_length: numberOrNull(plan?.enriched_prompt_length),
    preflight_status: stringOrNull(preflight?.status),
    opened_status: stringOrNull(opened?.status),
    opened_target_id: stringOrNull(openedSelected?.id),
    opened_url: stringOrNull(openedSelected?.url ?? opened?.current_url),
    opened_chat_id: stringOrNull(openedSelected?.chat_id ?? opened?.chat_id),
    drafted_status: stringOrNull(drafted?.status),
    draft_inner_status: stringOrNull(draft?.status),
    draft_hash: stringOrNull(drafted?.draft_hash),
    draft_length: numberOrNull(drafted?.draft_length),
    submitted_status: stringOrNull(submittedRecord?.status),
    submitted: submittedRecord?.submitted === true,
    submit_inner_status: stringOrNull(submit?.status),
    current_draft_hash: stringOrNull(submittedRecord?.current_draft_hash),
    current_draft_length: numberOrNull(submittedRecord?.current_draft_length),
    rate_limit_status: stringOrNull(rateLimit?.status),
    skipped_reusable_target_count: skipped.length,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function buildCmcpGoBrowserPreflight(ports: number[], timeoutMs: number): Promise<Record<string, unknown>> {
  const inventory = await collectChatGptTabInventory(ports, timeoutMs);
  const emptyHomeCount = Number(inventory.empty_home_count ?? 0);
  const duplicateChatIdCount = Number(inventory.duplicate_chat_id_count ?? 0);
  const blocked = emptyHomeCount > CHATGPT_EMPTY_HOME_BLOCK_THRESHOLD;
  return {
    ok: !blocked,
    status: blocked ? "CMCP_GO_PREFLIGHT_TOO_MANY_EMPTY_HOME_PAGES" : "CMCP_GO_PREFLIGHT_READY",
    empty_home_count: emptyHomeCount,
    empty_home_warning_threshold: CHATGPT_EMPTY_HOME_WARNING_THRESHOLD,
    empty_home_block_threshold: CHATGPT_EMPTY_HOME_BLOCK_THRESHOLD,
    duplicate_chat_id_count: duplicateChatIdCount,
    risk: blocked ? "high" : (emptyHomeCount >= CHATGPT_EMPTY_HOME_WARNING_THRESHOLD ? "elevated" : "normal"),
    recommended_action: blocked ? "run_empty_page_cleanup_preview_then_confirmed_cleanup" : null,
    details_omitted: true,
  };
}

async function applyBrowserSessionTitlePrefix(policy: ConsolePolicy, input: z.infer<typeof browserSessionTitlePrefixSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmTitlePrefix) return { ok: false, status: "CONFIRM_TITLE_PREFIX_REQUIRED", policy: buildBrowserSessionTitlePrefixPolicy() };
  if (!input.expectedTargetId && !input.expectedChatId) return { ok: false, status: "TITLE_PREFIX_TARGET_OR_CHAT_ID_REQUIRED", policy: buildBrowserSessionTitlePrefixPolicy() };

  const deadline = Date.now() + input.timeoutMs;
  const attempts: Array<Record<string, unknown>> = [];
  let lastTarget: OpenedChatGptTarget | null = null;
  let lastResult: Record<string, unknown> | null = null;

  while (Date.now() <= deadline) {
    const resolved = await resolveBrowserSessionTitlePrefixTarget(input);
    if (!resolved.ok || !resolved.target) {
      attempts.push({ ok: false, status: resolved.status, selected: resolved.target ? compactChatGptTarget(resolved.target) : null });
      lastResult = { ok: false, status: String(resolved.status), resolver: resolved };
      await delay(500);
      continue;
    }

    lastTarget = resolved.target;
    const result = await maybeApplyChatTitlePrefix(policy, input.workspacePath, input.chatTitleMode, resolved.target, Math.min(input.timeoutMs, 5000));
    attempts.push({ ...compactChatTitleAttempt(result), selected: compactChatGptTarget(resolved.target) });
    lastResult = result;
    if (!isChatTitlePrefixAutoTitlePending(result)) {
      return { ...result, selected: compactChatGptTarget(resolved.target), attempts, policy: buildBrowserSessionTitlePrefixPolicy() };
    }
    if (!input.waitForChatId) break;
    await delay(500);
  }

  return { ok: false, status: "TITLE_PREFIX_NOT_READY", selected: lastTarget ? compactChatGptTarget(lastTarget) : null, last_result: lastResult, attempts, policy: buildBrowserSessionTitlePrefixPolicy() };
}

async function resolveBrowserSessionTitlePrefixTarget(input: z.infer<typeof browserSessionTitlePrefixSchema>): Promise<{ ok: boolean; status: string; target: OpenedChatGptTarget | null }> {
  if (input.expectedChatId) {
    const target = await findBestChatGptTargetForChatId(input.ports, input.expectedChatId, input.timeoutMs);
    return target ? { ok: true, status: "TITLE_PREFIX_CHAT_ID_READY", target } : { ok: false, status: "TITLE_PREFIX_CHAT_ID_TARGET_NOT_FOUND", target: null };
  }

  const target = input.expectedTargetId ? await findDevToolsTargetById(input.ports, input.expectedTargetId, input.timeoutMs) : null;
  if (!target) return { ok: false, status: "TITLE_PREFIX_TARGET_NOT_FOUND", target: null };
  if (target.chat_id) return { ok: true, status: "TITLE_PREFIX_TARGET_CHAT_ID_READY", target };
  if (!input.waitForChatId || !target.id) return { ok: false, status: "TITLE_PREFIX_CHAT_ID_NOT_READY", target };
  const upgraded = await resolveChatGptDocumentTargetWithChatId(target.port, target.id, Math.min(input.timeoutMs, 10000));
  return upgraded?.chat_id ? { ok: true, status: "TITLE_PREFIX_TARGET_CHAT_ID_READY", target: upgraded } : { ok: false, status: "TITLE_PREFIX_CHAT_ID_NOT_READY", target: upgraded ?? target };
}

/* removed legacy open-draft/entrypoint implementation */
async function __removedLegacyOpenDraftMarker(): Promise<void> { return; }

/*
async function openChatGptChatDraft(policy: ConsolePolicy, input: z.infer<typeof chatOpenDraftInputSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmOpenDraft) {
    return { ok: false, status: "CONFIRM_OPEN_DRAFT_REQUIRED", target_url: normalizeChatGptUrl(input.url), will_submit: input.autoSubmit, policy: buildChatOpenDraftPolicy() };
  }
  if (input.autoSubmit && !input.confirmSubmit) {
    return { ok: false, status: "CONFIRM_SUBMIT_REQUIRED", target_url: normalizeChatGptUrl(input.url), will_submit: true, policy: buildChatOpenDraftPolicy() };
  }
  const skippedReusableTargets: Array<Record<string, unknown>> = [];
  const opened = await openChatGptChat(policy, { ports: input.ports, url: input.url, workspacePath: input.workspacePath, chatTitleMode: input.chatTitleMode, activate: input.activate, confirmOpen: true, timeoutMs: input.timeoutMs }, { requireEmptyHomeComposer: !input.allowOverwrite, skippedTargets: skippedReusableTargets });
  if (!opened.ok) return { ...opened, status: opened.status ?? "CHAT_OPEN_FAILED", skipped_reusable_targets: skippedReusableTargets, will_submit: input.autoSubmit, policy: buildChatOpenDraftPolicy() };
  const selected = opened.selected as OpenedChatGptTarget | undefined;
  const webSocketUrl = selected?.web_socket_debugger_url ?? selected?.webSocketDebuggerUrl ?? null;
  if (!selected || !webSocketUrl) return { ...opened, ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", will_submit: input.autoSubmit, policy: buildChatOpenDraftPolicy() };

  const runtimeDocument = await resolveRuntimeDocumentReady(webSocketUrl, input.timeoutMs);
  if (!Boolean((runtimeDocument as { ok?: unknown }).ok)) {
    return buildRecoverableOpenDraftResult(opened, selected, input, "runtime_document", runtimeDocument, "RUNTIME_DOCUMENT_NOT_READY");
  }

  const composer = await safeEvaluateInTarget(webSocketUrl, buildComposerProbeExpression(), input.timeoutMs, "COMPOSER_PROBE_EVALUATION_FAILED");
  if (!Boolean((composer as { ok?: unknown }).ok)) {
    return buildRecoverableOpenDraftResult(opened, selected, input, "composer_probe", composer, "COMPOSER_NOT_READY");
  }
  const draft = await safeEvaluateInTarget(webSocketUrl, buildDraftExpression(input.draftText, input.allowOverwrite), input.timeoutMs, "DRAFT_EVALUATION_FAILED");
  const draftOk = Boolean((draft as { ok?: unknown }).ok);
  const control = draftOk && input.autoSubmit ? await resolveSubmitControlReady(webSocketUrl, input.timeoutMs) : { ok: false, status: "AUTO_SEND_DISABLED" };
  const send = Boolean((control as { ok?: unknown }).ok) ? await safeEvaluateInTarget(webSocketUrl, buildSendExpression(), input.timeoutMs, "SEND_EVALUATION_FAILED") : control;
  const sendOk = Boolean((send as { ok?: unknown }).ok);
  const selectedAfterSend = sendOk && selected.id ? await resolveChatGptDocumentTargetWithChatId(selected.port, selected.id, input.timeoutMs) : null;
  const labelTarget = selectedAfterSend ?? selected;
  const titleTarget = labelTarget.chat_id ? await findBestChatGptTargetForChatId(input.ports, labelTarget.chat_id, input.timeoutMs) ?? labelTarget : labelTarget;
  const chatTitle = sendOk ? await maybeApplyChatTitlePrefixAfterPromptSend(policy, input.workspacePath, input.chatTitleMode, titleTarget, input.timeoutMs) : opened.chat_title;
  const titleOk = !chatTitle || (chatTitle as { ok?: unknown }).ok !== false || isChatTitlePrefixAutoTitlePending(chatTitle);
  return { ...opened, selected: titleTarget, opened_target: labelTarget, chat_id: titleTarget.chat_id, current_url: titleTarget.url ?? opened.current_url, ok: draftOk && (!input.autoSubmit || sendOk) && titleOk, status: input.autoSubmit ? (sendOk ? (titleOk ? "CHATGPT_CHAT_OPENED_DRAFT_SENT" : "CHATGPT_CHAT_OPENED_DRAFT_SENT_TITLE_PREFIX_BLOCKED") : "CHATGPT_CHAT_OPENED_SEND_BLOCKED") : (draftOk ? "CHATGPT_CHAT_OPENED_DRAFT_WRITTEN" : "CHATGPT_CHAT_OPENED_DRAFT_BLOCKED"), draft, send, chat_title: chatTitle, skipped_reusable_targets: skippedReusableTargets, draft_length: input.draftText.length, will_submit: input.autoSubmit, submitted: sendOk, policy: buildChatOpenDraftPolicy() };
}

async function startChatGptEntrypoint(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof chatGptEntrypointStartInputSchema>): Promise<Record<string, unknown>> {
  const plan = buildChatGptEntrypointPlan({
    rawPrompt: input.rawPrompt,
    workspacePath: input.workspacePath,
    componentName: input.componentName,
    taskPreset: input.taskPreset,
    maxAutoIterations: input.maxAutoIterations,
  });
  const enrichedPrompt = typeof plan.enrichedPrompt === "string" ? plan.enrichedPrompt : input.rawPrompt;
  const beforeHead = await captureWorkspaceHead(policy, input.workspacePath);
  if (!input.confirmStart) {
    return {
      ok: false,
      status: "CONFIRM_ENTRYPOINT_START_REQUIRED",
      will_submit: input.autoSubmit,
      will_start_daemon: plan.autoRun === true && input.autoSubmit,
      before_head: beforeHead,
      plan,
      policy: buildChatGptEntrypointStartPolicy(),
    };
  }

  const opened = await openChatGptChatDraft(policy, {
    ports: input.ports,
    url: input.url,
    draftText: enrichedPrompt,
    workspacePath: input.workspacePath,
    chatTitleMode: input.chatTitleMode,
    allowOverwrite: input.allowOverwrite,
    autoSubmit: input.autoSubmit,
    confirmSubmit: input.autoSubmit,
    activate: input.activate,
    confirmOpenDraft: true,
    timeoutMs: input.timeoutMs,
  });
  const chatId = typeof opened.chat_id === "string" && opened.chat_id.length > 0 ? opened.chat_id : null;
  const shouldStartDaemon = plan.autoRun === true && input.autoSubmit && opened.submitted === true && chatId !== null;
  const daemon = shouldStartDaemon ? await startChatGptRunLoopDaemon(policy, baseDir, {
    workspacePath: input.workspacePath,
    beforeHead: beforeHead ?? undefined,
    ports: input.ports,
    checkNames: [],
    preferredChatId: chatId,
    requireChatId: true,
    maxMessages: 30,
    timeoutMs: 2000,
    phase: "reply_watch",
    taskClass: "repo_rc_implementation",
    iteration: 0,
    maxIterations: input.maxAutoIterations,
    attempt: 0,
    executePreAsk: true,
    gatewayAskMode: "off",
    gatewayMaxOutputTokens: 1200,
    gatewayTemperature: 0.1,
    gatewayTimeoutMs: 60000,
    maxAutoIterations: input.maxAutoIterations,
    maxElapsedMs: 7200000,
    pollMs: 15000,
    minWaitMs: 3000,
    maxWaitMs: 30000,
    stopOnReturnToChat: true,
    stopOnPreAskExecuted: true,
    runId: input.runId ?? deriveEntrypointRunId(input.componentName, input.workspacePath, chatId),
    replaceExisting: input.replaceExistingDaemon,
  }) : { ok: false, status: "DAEMON_NOT_STARTED", reason: buildEntrypointDaemonSkipReason(plan, input, opened, chatId) };

  return {
    ok: opened.ok === true && (shouldStartDaemon ? daemon.ok === true : true),
    status: shouldStartDaemon ? (daemon.ok === true ? "ENTRYPOINT_STARTED" : "ENTRYPOINT_SENT_DAEMON_BLOCKED") : "ENTRYPOINT_SENT_DAEMON_SKIPPED",
    plan,
    opened,
    before_head: beforeHead,
    chat_id: chatId,
    daemon,
    policy: buildChatGptEntrypointStartPolicy(),
  };
}

async function captureWorkspaceHead(policy: ConsolePolicy, workspacePath: string): Promise<string | null> {
  try {
    const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
    const result = await runSupervisedCommand(cwd, "git", ["rev-parse", "HEAD"], 30000, 1024 * 1024);
    const head = result.stdout.trim();
    if (!result.ok || head.length !== 40) return null;
    return /^[A-Fa-f0-9]+$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

*/
async function maybeApplyChatTitlePrefix(policy: ConsolePolicy, workspacePath: string | undefined, mode: ChatTitleMode, target: OpenedChatGptTarget, timeoutMs: number): Promise<Record<string, unknown>> {
  if (mode === "off") return { ok: true, status: "CHAT_TITLE_PREFIX_OFF" };
  if (!workspacePath) return { ok: true, status: "CHAT_TITLE_PREFIX_NO_WORKSPACE" };

  const component = await resolveChatGptComponentLabel(policy, workspacePath, target.chat_id);
  if (!component.ok) return { ok: false, status: component.status, component };
  if (mode === "auto" && !target.chat_id) return { ok: true, status: "CHAT_TITLE_PREFIX_WAITING_FOR_CHAT_ID", component };
  if (!target.chat_id) return { ok: false, status: "CHAT_TITLE_PREFIX_CHAT_ID_MISSING", component };
  const webSocketUrl = target.web_socket_debugger_url ?? target.webSocketDebuggerUrl ?? null;
  if (!webSocketUrl) return { ok: false, status: "CHAT_TITLE_PREFIX_NEED_DEVTOOLS_WEBSOCKET", component };
  if (!component.title_prefix || !component.component_token || !component.package_token || !component.composer_name || !component.chat_stamp) {
    return { ok: false, status: "CHAT_TITLE_PREFIX_METADATA_INCOMPLETE", component };
  }

  const runtimeReady = await resolveRuntimeChatIdReady(webSocketUrl, target.chat_id, timeoutMs).catch((error) => ({ ok: false, status: "CHAT_TITLE_PREFIX_RUNTIME_EVALUATION_FAILED", error: error instanceof Error ? error.message : String(error) }));
  if (!Boolean((runtimeReady as { ok?: unknown }).ok)) {
    return { ok: mode === "auto", status: "CHAT_TITLE_PREFIX_WAITING_FOR_CHAT_ID", component, runtime_ready: runtimeReady };
  }
  const renameResult = await evaluateInTarget(webSocketUrl, buildRenameConversationExpression(target.chat_id, component.title_prefix), timeoutMs).catch((error) => ({ ok: false, status: "CHAT_TITLE_PREFIX_RENAME_EVALUATION_FAILED", error: error instanceof Error ? error.message : String(error) }));
  const renameBlockedStatus = classifyChatTitlePrefixRenameBlockedStatus(renameResult);
  const desiredTitle = typeof (renameResult as { desired_title?: unknown }).desired_title === "string" ? (renameResult as { desired_title: string }).desired_title : null;
  const renameStatus = typeof (renameResult as { status?: unknown }).status === "string" ? (renameResult as { status: string }).status : null;
  if (!shouldRecordChatGptComponentChatToken(renameResult as { ok?: unknown })) {
    return {
      ok: false,
      status: renameBlockedStatus,
      component,
      rename: renameResult,
      registry: { ok: false, status: "CHAT_COMPONENT_TOKEN_NOT_RECORDED_RENAME_FAILED", chat_id: target.chat_id },
    };
  }
  const registry = await recordChatGptComponentChatToken(policy, {
    chat_id: target.chat_id,
    component_token: component.component_token,
    package_token: component.package_token,
    composer_name: component.composer_name,
    workspace_path: component.workspace_path,
    workspace_folder: component.workspace_folder,
    chat_stamp: component.chat_stamp,
    title_prefix: component.title_prefix,
    desired_title: desiredTitle,
    rename_status: renameStatus,
  });

  return { ok: true, status: "CHAT_TITLE_PREFIX_APPLIED", component, rename: renameResult, registry };
}

async function maybeApplyChatTitlePrefixAfterPromptSend(policy: ConsolePolicy, workspacePath: string | undefined, mode: ChatTitleMode, target: OpenedChatGptTarget, timeoutMs: number): Promise<Record<string, unknown>> {
  if (mode === "auto") return { ok: true, status: "CHAT_TITLE_PREFIX_DEFERRED_UNTIL_ASSISTANT_SETTLED", chat_id: target.chat_id ?? null };
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 3000), 15000);
  const attempts: Array<Record<string, unknown>> = [];
  let last: Record<string, unknown> | null = null;

  while (Date.now() <= deadline) {
    last = await maybeApplyChatTitlePrefix(policy, workspacePath, mode, target, timeoutMs);
    attempts.push(compactChatTitleAttempt(last));
    if (!isChatTitlePrefixAutoTitlePending(last)) {
      return attempts.length === 1 ? last : { ...last, attempts };
    }
    await delay(500);
  }

  const fallback = last ?? { ok: false, status: "CHAT_TITLE_PREFIX_WAITING_FOR_FIRST_PROMPT" };
  return {
    ...fallback,
    attempts,
  };
}

function isChatTitlePrefixAutoTitlePending(value: unknown): boolean {
  const topLevel = value as { status?: unknown; rename?: unknown } | null;
  const rename = topLevel?.rename as { status?: unknown } | null | undefined;
  const status = typeof topLevel?.status === "string" ? topLevel.status : null;
  const renameStatus = typeof rename?.status === "string" ? rename.status : null;
  return status === "CHAT_TITLE_PREFIX_WAITING_FOR_FIRST_PROMPT" || status === "CHAT_TITLE_PREFIX_AUTO_TITLE_PENDING" || renameStatus === "CHAT_TITLE_PREFIX_WAITING_FOR_FIRST_PROMPT";
}

function isChatTitlePrefixEvaluationTimeout(value: unknown): boolean {
  const topLevel = value as { rename?: unknown } | null;
  const rename = topLevel?.rename as { status?: unknown; error?: unknown } | null | undefined;
  return rename?.status === "CHAT_TITLE_PREFIX_RENAME_EVALUATION_FAILED" && typeof rename.error === "string" && rename.error.includes("DevTools evaluation timed out");
}

function classifyChatTitlePrefixRenameBlockedStatus(value: unknown): string {
  const rename = value as { conversation_get_body_preview?: unknown; conversation_get_http_status?: unknown } | null;
  const preview = typeof rename?.conversation_get_body_preview === "string" ? rename.conversation_get_body_preview : "";
  const getStatus = typeof rename?.conversation_get_http_status === "number" ? rename.conversation_get_http_status : null;
  if (getStatus === 404 && preview.includes("conversation_deleted")) return "CHAT_TITLE_PREFIX_CHAT_DELETED";
  if (getStatus === 401 || getStatus === 403) return "CHAT_TITLE_PREFIX_AUTH_BLOCKED";
  return "CHAT_TITLE_PREFIX_RENAME_FAILED";
}

async function safeEvaluateInTarget(webSocketUrl: string, expression: string, timeoutMs: number, status: string): Promise<unknown> {
  try {
    return await evaluateInTarget(webSocketUrl, expression, timeoutMs);
  } catch (error) {
    return { ok: false, status, error: error instanceof Error ? error.message : String(error), recoverable: true };
  }
}

async function safeSendDevToolsCommand(webSocketUrl: string, method: string, params: Record<string, unknown>, timeoutMs: number, status: string): Promise<Record<string, unknown>> {
  try {
    return { ok: true, status: "DEVTOOLS_COMMAND_SENT", method, result: await sendDevToolsCommand(webSocketUrl, method, params, timeoutMs) };
  } catch (error) {
    return { ok: false, status, method, error: error instanceof Error ? error.message : String(error), recoverable: true };
  }
}

/*
function classifyChatTitlePrefixRenameBlockedStatus(value: unknown): string {
  const rename = value as { conversation_get_body_preview?: unknown; conversation_get_http_status?: unknown } | null;
  const preview = typeof rename?.conversation_get_body_preview === "string" ? rename.conversation_get_body_preview : "";
  const getStatus = typeof rename?.conversation_get_http_status === "number" ? rename.conversation_get_http_status : null;
  if (getStatus === 404 && preview.includes("conversation_deleted")) return "CHAT_TITLE_PREFIX_CHAT_DELETED";
  if (getStatus === 401 || getStatus === 403) return "CHAT_TITLE_PREFIX_AUTH_BLOCKED";
  return "CHAT_TITLE_PREFIX_RENAME_FAILED";
}

function buildRecoverableOpenDraftResult(
  opened: Record<string, unknown>,
  selected: OpenedChatGptTarget,
  input: z.infer<typeof chatOpenDraftInputSchema>,
  failedStep: string,
  stepResult: unknown,
  status: string,
): Record<string, unknown> {
  return {
    ...opened,
    ok: false,
    status,
    recoverable: true,
    failed_step: failedStep,
    selected,
    step_result: stepResult,
    draft_length: input.draftText.length,
    will_submit: input.autoSubmit,
    submitted: false,
    recovery: {
      reason: "CHATGPT_TARGET_OPENED_BUT_RUNTIME_STEP_FAILED",
      next_tool: "console.write.browser.session.input.draft",
      expected_target_id: selected.id ?? null,
      allow_overwrite: input.allowOverwrite,
      auto_submit: input.autoSubmit,
      confirm_draft: true,
      confirm_submit: input.autoSubmit,
      timeout_ms: Math.min(Math.max(input.timeoutMs * 2, 3000), 10000),
    },
    policy: buildChatOpenDraftPolicy(),
  };
}

function classifyChatTitlePrefixRenameBlockedStatus(value: unknown): string {
  const rename = value as { conversation_get_body_preview?: unknown; conversation_get_http_status?: unknown } | null;
  const preview = typeof rename?.conversation_get_body_preview === "string" ? rename.conversation_get_body_preview : "";
  const getStatus = typeof rename?.conversation_get_http_status === "number" ? rename.conversation_get_http_status : null;
  if (getStatus === 404 && preview.includes("conversation_deleted")) return "CHAT_TITLE_PREFIX_CHAT_DELETED";
  if (getStatus === 401 || getStatus === 403) return "CHAT_TITLE_PREFIX_AUTH_BLOCKED";
  return "CHAT_TITLE_PREFIX_RENAME_FAILED";
}

*/
function compactChatTitleAttempt(value: Record<string, unknown>): Record<string, unknown> {
  const rename = value.rename as { status?: unknown; current_title?: unknown; desired_title?: unknown; http_status?: unknown } | undefined;
  return { ok: value.ok, status: value.status, rename_status: rename?.status, current_title: rename?.current_title, desired_title: rename?.desired_title, http_status: rename?.http_status };
}

function normalizeChatGptUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!url.hash.startsWith("#settings/")) url.hash = "";
  url.username = "";
  url.password = "";
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https ChatGPT URLs are allowed.");
  if (host !== "chatgpt.com" && !host.endsWith(".chatgpt.com") && host !== "chat.openai.com") throw new Error(`Only ChatGPT URLs are allowed: ${url.origin}`);
  if (host === "chat.openai.com") url.hostname = "chatgpt.com";
  return url.toString();
}

function normalizeTarget(port: number, target: BrowserDebugTarget): OpenedChatGptTarget | null {
  const url = typeof target.url === "string" ? target.url : "";
  if (target.type !== "page" || !isChatGptUrl(url)) return null;
  return { ...target, port, chat_id: extractChatGptChatId(url), web_socket_debugger_url: target.webSocketDebuggerUrl ?? null };
}

function isChatGptUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com";
  } catch {
    return false;
  }
}

function isChatGptHomeUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return isChatGptUrl(rawUrl) && (url.pathname === "/" || url.pathname === "") && !extractChatGptChatId(rawUrl) && !isChatGptSettingsSurfaceUrl(rawUrl);
  } catch {
    return false;
  }
}

async function collectChatGptTabInventory(ports: number[], timeoutMs: number): Promise<Record<string, unknown>> {
  const attempts: Array<Record<string, unknown>> = [];
  const targets: OpenedChatGptTarget[] = [];
  for (const port of [...new Set(ports)]) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const list = JSON.parse(raw) as BrowserDebugTarget[];
      const normalized = (Array.isArray(list) ? list : []).map((target) => normalizeTarget(port, target)).filter((target): target is OpenedChatGptTarget => target !== null);
      targets.push(...normalized);
      attempts.push({ port, ok: true, target_count: normalized.length });
    } catch (error) {
      attempts.push({ port, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const emptyHomeTargets = targets.filter((target) => isChatGptHomeUrl(target.url ?? ""));
  const byChatId = new Map<string, OpenedChatGptTarget[]>();
  for (const target of targets) {
    if (!target.chat_id) continue;
    const current = byChatId.get(target.chat_id) ?? [];
    current.push(target);
    byChatId.set(target.chat_id, current);
  }
  const duplicateChatIds = [...byChatId.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([chatId, items]) => ({ chat_id: chatId, count: items.length, targets: items.map(compactChatGptTarget) }));
  return {
    ports: [...new Set(ports)],
    attempts,
    total_chatgpt_targets: targets.length,
    empty_home_count: emptyHomeTargets.length,
    chat_target_count: targets.filter((target) => Boolean(target.chat_id)).length,
    unique_chat_id_count: byChatId.size,
    duplicate_chat_id_count: duplicateChatIds.length,
    duplicate_chat_ids: duplicateChatIds,
    empty_home_targets: emptyHomeTargets,
    targets: targets.map(compactChatGptTarget),
  };
}

async function findReusableChatGptTarget(ports: number[], targetUrl: string, timeoutMs: number, options: ChatGptReuseOptions = {}): Promise<OpenedChatGptTarget | null> {
  const targetChatId = extractChatGptChatId(targetUrl);
  if (targetChatId) return findBestChatGptTargetForChatId(ports, targetChatId, timeoutMs);
  if (!isChatGptHomeUrl(targetUrl)) return null;
  const candidates: OpenedChatGptTarget[] = [];
  for (const port of [...new Set(ports)]) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const targets = JSON.parse(raw) as BrowserDebugTarget[];
      for (const target of Array.isArray(targets) ? targets : []) {
        const normalized = normalizeTarget(port, target);
        if (normalized && isChatGptHomeUrl(normalized.url ?? "") && normalized.web_socket_debugger_url) candidates.push(normalized);
      }
    } catch {
      continue;
    }
  }
  candidates.sort((left, right) => String(right.id ?? "").localeCompare(String(left.id ?? "")));
  if (options.requireEmptyHomeComposer !== true) return candidates[0] ?? null;
  return await findFirstEmptyComposerHomeTarget(candidates, timeoutMs, options);
}

async function findFirstEmptyComposerHomeTarget(candidates: OpenedChatGptTarget[], timeoutMs: number, options: ChatGptReuseOptions): Promise<OpenedChatGptTarget | null> {
  for (const candidate of candidates) {
    const webSocketUrl = candidate.web_socket_debugger_url ?? candidate.webSocketDebuggerUrl ?? null;
    if (!webSocketUrl) {
      options.skippedTargets?.push({ target: compactChatGptTarget(candidate), status: "REUSABLE_HOME_TARGET_SKIPPED_NO_WEBSOCKET" });
      continue;
    }
    const composer = await safeEvaluateInTarget(webSocketUrl, buildComposerTextProbeExpression(), Math.min(timeoutMs, 1000), "COMPOSER_TEXT_PROBE_FAILED");
    const composerRecord = typeof composer === "object" && composer !== null ? composer as { textLength?: unknown } : null;
    const textLength = typeof composerRecord?.textLength === "number" ? composerRecord.textLength : null;
    if (textLength === null || textLength > 0) {
      options.skippedTargets?.push({ target: compactChatGptTarget(candidate), status: "REUSABLE_HOME_TARGET_COMPOSER_NOT_EMPTY", composer });
      continue;
    }
    return candidate;
  }
  return null;
}

function isChatGptSettingsSurfaceUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    const marker = `${url.pathname}${url.hash}${url.search}`.toLowerCase();
    return marker.includes("settings") || marker.includes("connectors");
  } catch {
    const marker = String(rawUrl).toLowerCase();
    return marker.includes("settings") || marker.includes("connectors");
  }
}

function compactChatGptTarget(target: OpenedChatGptTarget): Record<string, unknown> {
  return {
    port: target.port,
    id: target.id ?? null,
    type: target.type ?? null,
    title: target.title ?? null,
    url: target.url ?? null,
    chat_id: target.chat_id ?? null,
    has_web_socket_debugger_url: Boolean(target.web_socket_debugger_url ?? target.webSocketDebuggerUrl),
  };
}

async function inspectCloseSafety(target: OpenedChatGptTarget, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!target.id) return { ok: false, status: "TARGET_ID_MISSING" };
  if (!isChatGptHomeUrl(target.url ?? "")) return { ok: false, status: "TARGET_NOT_EMPTY_HOME", url: target.url ?? null };
  const activity = await inspectTargetActivity(target, timeoutMs);
  if (activity.protected === true) return { ok: false, status: "ACTIVE_BROWSER_TAB_PROTECTED", activity };
  if (isSafeRootTargetWithoutComposerProbe(target)) return { ok: true, status: "EMPTY_ROOT_TARGET_SAFE_TO_CLOSE_WITHOUT_COMPOSER_PROBE", root_target: true };
  const webSocketUrl = target.web_socket_debugger_url ?? target.webSocketDebuggerUrl ?? null;
  if (!webSocketUrl) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET" };
  const composer = await safeEvaluateInTarget(webSocketUrl, buildComposerTextProbeExpression(), Math.min(timeoutMs, 1000), "COMPOSER_TEXT_PROBE_FAILED");
  const composerRecord = typeof composer === "object" && composer !== null ? composer as { textLength?: unknown } : null;
  const textLength = typeof composerRecord?.textLength === "number" ? composerRecord.textLength : null;
  if (textLength === null) return { ok: false, status: "COMPOSER_TEXT_PROBE_INCONCLUSIVE", composer };
  if (textLength > 0) return { ok: false, status: "COMPOSER_NOT_EMPTY", composer };
  return { ok: true, status: "EMPTY_HOME_TARGET_SAFE_TO_CLOSE", composer };
}

async function inspectTargetActivity(target: OpenedChatGptTarget, timeoutMs: number): Promise<Record<string, unknown>> {
  const webSocketUrl = target.web_socket_debugger_url ?? target.webSocketDebuggerUrl ?? null;
  if (!webSocketUrl) return { ok: false, status: "ACTIVE_TAB_GUARD_WEBSOCKET_MISSING", protected: true };
  const result = await safeEvaluateInTarget(
    webSocketUrl,
    `(() => ({ ok: true, visibility_state: document.visibilityState, has_focus: document.hasFocus(), hidden: document.hidden, href: location.href }))()`,
    Math.min(timeoutMs, 1000),
    "ACTIVE_TAB_GUARD_EVALUATION_FAILED",
  );
  const record = asRecord(result);
  if (!record || record.ok !== true) return { ok: false, status: "ACTIVE_TAB_GUARD_INCONCLUSIVE", protected: true, probe: result };
  const visible = record.visibility_state === "visible" || record.hidden === false;
  const focused = record.has_focus === true;
  return {
    ok: true,
    status: visible || focused ? "ACTIVE_BROWSER_TAB_PROTECTED" : "BACKGROUND_BROWSER_TAB_CLOSABLE",
    protected: visible || focused,
    visibility_state: record.visibility_state ?? null,
    has_focus: focused,
    hidden: record.hidden ?? null,
  };
}

function isSafeRootTargetWithoutComposerProbe(target: OpenedChatGptTarget): boolean {
  if (target.chat_id) return false;
  if (target.type !== "page") return false;
  const title = String(target.title ?? "").trim();
  if (title.length > 0 && title !== "ChatGPT") return false;
  try {
    const url = new URL(target.url ?? "");
    if (!isChatGptUrl(url.toString())) return false;
    if (url.pathname !== "/" && url.pathname !== "") return false;
    if (extractChatGptChatId(url.toString())) return false;
    return url.hash === "" || url.hash.startsWith("#settings/");
  } catch {
    return false;
  }
}

function buildComposerTextProbeExpression(): string {
  return `(() => { const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', '[data-testid="prompt-textarea"]', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', '.ProseMirror', 'main form textarea', 'main form [contenteditable="true"]']; const candidates = selectors.map((selector) => document.querySelector(selector)).filter(Boolean); const readText = (node) => String(('value' in node ? node.value : node.innerText || node.textContent || '') || ''); const texts = candidates.map(readText).map((text) => text.trim()).filter((text) => text.length > 0); return { ok: true, status: texts.length > 0 ? 'COMPOSER_TEXT_PRESENT' : 'COMPOSER_TEXT_EMPTY', candidateCount: candidates.length, textLength: texts.join('\\n').length, href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function buildInputSnapshotExpression(): string {
  return `(() => { const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const candidates = selectors.map((selector) => document.querySelector(selector)).filter(Boolean); const editable = (node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror'); let target = candidates.find(editable); if (target && !editable(target) && target.querySelector) target = target.querySelector('textarea, [contenteditable="true"], .ProseMirror'); const readText = (node) => String(('value' in node ? node.value : node.innerText || node.textContent || '') || ''); const text = target ? readText(target).trim() : ''; return { ok: Boolean(target), status: target ? (text.length > 0 ? 'INPUT_TEXT_PRESENT' : 'INPUT_TEXT_EMPTY') : 'INPUT_NOT_FOUND', candidateCount: candidates.length, textLength: text.length, text, targetTag: target ? target.tagName : null, targetClass: target ? String(target.className || '') : null, activeTag: document.activeElement ? document.activeElement.tagName : null, href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function redactInputSnapshot(snapshot: unknown, draftHash: string | null): Record<string, unknown> {
  const value = typeof snapshot === "object" && snapshot !== null ? snapshot as Record<string, unknown> : { raw: snapshot };
  const { text: _text, ...rest } = value;
  return { ...rest, text_redacted: true, draft_hash: draftHash };
}

function createDevToolsTarget(port: number, url: string, timeoutMs: number): Promise<BrowserDebugTarget> {
  return devToolsTextRequest(port, `/json/new?${encodeURIComponent(url)}`, "PUT", timeoutMs).then((raw) => JSON.parse(raw) as BrowserDebugTarget);
}

async function activateDevToolsTarget(port: number, targetId: string, timeoutMs: number): Promise<void> {
  await devToolsTextRequest(port, `/json/activate/${encodeURIComponent(targetId)}`, "GET", timeoutMs);
}

function closeDevToolsTarget(port: number, targetId: string, timeoutMs: number): Promise<string> {
  return devToolsTextRequest(port, `/json/close/${encodeURIComponent(targetId)}`, "GET", timeoutMs);
}

async function resolveChatGptDocumentTarget(port: number, targetId: string, timeoutMs: number): Promise<OpenedChatGptTarget | null> {
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  let last: BrowserDebugTarget | null = null;
  while (Date.now() <= deadline) {
    const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
    const targets = JSON.parse(raw) as BrowserDebugTarget[];
    const candidate = Array.isArray(targets) ? targets.find((item) => item.id === targetId) : undefined;
    if (candidate) {
      last = candidate;
      const normalized = normalizeTarget(port, candidate);
      if (normalized && normalized.url && normalized.url !== "about:blank") return normalized;
    }
    await delay(100);
  }
  return last ? normalizeTarget(port, last) : null;
}

async function resolveChatGptDocumentTargetWithChatId(port: number, targetId: string, timeoutMs: number): Promise<OpenedChatGptTarget | null> {
  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  let last: OpenedChatGptTarget | null = null;
  while (Date.now() <= deadline) {
    const current = await resolveChatGptDocumentTarget(port, targetId, Math.min(timeoutMs, 1000));
    if (current) {
      last = current;
      if (current.chat_id) return current;
      const webSocketUrl = current.web_socket_debugger_url ?? current.webSocketDebuggerUrl ?? null;
      if (typeof webSocketUrl === "string" && webSocketUrl !== "") {
        const runtime = await safeEvaluateInTarget(webSocketUrl, buildRuntimeChatIdProbeExpression(""), Math.min(timeoutMs, 1000), "RUNTIME_CHAT_ID_PROBE_EVALUATION_FAILED");
        const runtimeState = typeof runtime === "object" && runtime !== null ? runtime as Record<string, unknown> : null;
        const runtimeChatId = typeof runtimeState?.current_chat_id === "string" && runtimeState.current_chat_id !== "" ? runtimeState.current_chat_id : null;
        const runtimeHref = typeof runtimeState?.href === "string" && runtimeState.href !== "" ? runtimeState.href : null;
        if (runtimeChatId !== null || (runtimeHref !== null && extractChatGptChatId(runtimeHref) !== null)) {
          return { ...current, runtime_href: runtimeHref, runtime_chat_id: runtimeChatId ?? (runtimeHref !== null ? extractChatGptChatId(runtimeHref) : null) };
        }
      }
    }
    await delay(150);
  }
  return last;
}

async function openChatGptTargetForChatId(ports: number[], chatId: string, timeoutMs: number): Promise<OpenedChatGptTarget | null> {
  for (const port of [...new Set(ports)]) {
    try {
      const created = await createDevToolsTarget(port, `https://chatgpt.com/c/${encodeURIComponent(chatId)}`, timeoutMs);
      if (!created.id) continue;
      const opened = await resolveChatGptDocumentTargetWithChatId(port, created.id, timeoutMs);
      if (opened && (opened.chat_id === chatId || opened.runtime_chat_id === chatId)) return opened;
    } catch {
      continue;
    }
  }
  return null;
}

async function findBestChatGptTargetForChatId(ports: number[], chatId: string, timeoutMs: number): Promise<OpenedChatGptTarget | null> {
  const matches: OpenedChatGptTarget[] = [];
  for (const port of [...new Set(ports)]) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const targets = JSON.parse(raw) as BrowserDebugTarget[];
      for (const target of Array.isArray(targets) ? targets : []) {
        const normalized = normalizeTarget(port, target);
        if (normalized?.chat_id === chatId && normalized.web_socket_debugger_url) matches.push(normalized);
      }
    } catch {
      continue;
    }
  }
  matches.sort((left, right) => scoreChatGptRenameTarget(right) - scoreChatGptRenameTarget(left));
  return matches[0] ?? null;
}

function scoreChatGptRenameTarget(target: OpenedChatGptTarget): number {
  const rawUrl = target.url ?? "";
  let score = 0;
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has("mweb_fallback")) score += 200;
    if (url.hostname.toLowerCase() === "chatgpt.com") score += 20;
    if (url.pathname.startsWith("/c/")) score += 10;
    if (target.title && target.title !== "ChatGPT") score += 5;
  } catch {
    return score;
  }
  return score;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findDevToolsTargetById(ports: number[], targetId: string, timeoutMs: number): Promise<OpenedChatGptTarget | null> {
  for (const port of [...new Set(ports)]) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const targets = JSON.parse(raw) as BrowserDebugTarget[];
      const target = Array.isArray(targets) ? targets.find((candidate) => candidate.id === targetId) : undefined;
      if (target) return normalizeTarget(port, target);
    } catch {
      continue;
    }
  }
  return null;
}

function devToolsTextRequest(port: number, path: string, method: "GET" | "PUT", timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`DevTools ${method} ${path} failed with HTTP ${res.statusCode}: ${body}`));
        else resolve(body);
      });
    });
    req.on("timeout", () => req.destroy(new Error(`DevTools request timed out on port ${port}.`)));
    req.on("error", reject);
    req.end();
  });
}

async function resolveRuntimeDocumentReady(webSocketUrl: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  let last: unknown = null;
  while (Date.now() <= deadline) {
    last = await safeEvaluateInTarget(webSocketUrl, buildRuntimeDocumentProbeExpression(), Math.min(timeoutMs, 1000), "RUNTIME_DOCUMENT_EVALUATION_FAILED");
    if (Boolean((last as { ok?: unknown }).ok)) return last;
    await delay(100);
  }
  return last ?? { ok: false, status: "RUNTIME_DOCUMENT_UNKNOWN" };
}

function buildRuntimeDocumentProbeExpression(): string {
  return `(() => { const host = location.hostname.toLowerCase(); const ready = document.readyState === 'interactive' || document.readyState === 'complete'; const chatgpt = host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com'; return { ok: chatgpt && ready && location.href !== 'about:blank', status: chatgpt && ready ? 'RUNTIME_DOCUMENT_READY' : 'RUNTIME_DOCUMENT_NOT_READY', host, href: location.href, readyState: document.readyState, title: document.title }; })()`;
}

function buildComposerProbeExpression(): string {
  return `(() => { const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', '[data-testid="prompt-textarea"]', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', '.ProseMirror', 'main form textarea', 'main form [contenteditable="true"]']; const target = selectors.map((selector) => document.querySelector(selector)).find(Boolean); return { ok: Boolean(target), status: target ? 'COMPOSER_READY' : 'COMPOSER_NOT_READY', readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function buildComposerPreflightExpression(): string {
  return `(() => { const composerSelectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const sendSelectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[data-testid*="send" i]', 'button[data-testid*="submit" i]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label*="send" i]', 'button[aria-label*="submit" i]', '#composer-submit-button', 'form button[type="submit"]']; const readText = (node) => String(('value' in node ? node.value : node.innerText || node.textContent || '') || ''); const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const composerCandidates = composerSelectors.map((selector) => document.querySelector(selector)).filter(Boolean); let composerNode = composerCandidates.find((node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror')); if (composerNode && !(composerNode instanceof HTMLTextAreaElement) && composerNode.getAttribute('contenteditable') !== 'true' && composerNode.querySelector) composerNode = composerNode.querySelector('textarea, [contenteditable="true"], .ProseMirror'); const composerContainer = composerNode ? (composerNode.closest('form') || composerNode.closest('[data-testid*=composer], [class*=composer], main') || document) : document; const explicitSendNode = sendSelectors.map((selector) => document.querySelector(selector)).filter(Boolean).find(visible) || null; const nearbyButtons = Array.from((composerContainer || document).querySelectorAll('button')).filter((node) => visible(node)); const enabledNearbyButtons = nearbyButtons.filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true'); const sendNode = explicitSendNode || enabledNearbyButtons.find((node) => { const label = String(node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('data-testid') || node.innerText || node.textContent || '').toLowerCase(); if (label.includes('send') || label.includes('submit') || label.includes('arrow')) return true; const svgCount = node.querySelectorAll('svg').length; const text = String(node.innerText || node.textContent || '').trim(); return svgCount > 0 && text.length <= 40; }) || null; const composerRect = composerNode && composerNode.getBoundingClientRect ? composerNode.getBoundingClientRect() : null; const sendRect = sendNode && sendNode.getBoundingClientRect ? sendNode.getBoundingClientRect() : null; const intersects = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; const viewportArea = Math.max(1, window.innerWidth * window.innerHeight); const blockers = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-radix-popper-content-wrapper], [data-headlessui-state], .fixed, .absolute')).filter((node) => visible(node)).map((node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); const z = Number.parseInt(style.zIndex || '0', 10) || 0; const area = rect.width * rect.height; const coversComposer = Boolean(intersects(rect, composerRect) || intersects(rect, sendRect)); const modal = node.getAttribute('aria-modal') === 'true' || node.getAttribute('role') === 'dialog'; const highLayer = (style.position === 'fixed' || style.position === 'absolute') && z >= 20 && area > 5000; return { node, rect, style, z, area, coversComposer, modal, highLayer }; }).filter((item) => item.coversComposer || (item.node.getAttribute('aria-modal') === 'true' && item.area > viewportArea * 0.15)).sort((a, b) => (b.modal === a.modal ? b.z - a.z : (b.modal ? 1 : -1))); const blocker = blockers[0] || null; const sendDisabled = sendNode ? Boolean(sendNode.disabled) || sendNode.getAttribute('aria-disabled') === 'true' : true; const composerText = composerNode ? readText(composerNode).trim() : ''; const overlayText = blocker ? String(blocker.node.innerText || blocker.node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : ''; const messageNodes = Array.from(document.querySelectorAll('[data-message-author-role]')).filter(visible); const userMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'user'); const assistantMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'assistant'); const visibleTextSample = String(document.body?.innerText || document.documentElement?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300); const overlay = blocker ? { present: true, role: blocker.node.getAttribute('role'), ariaModal: blocker.node.getAttribute('aria-modal'), zIndex: blocker.z, coversComposer: blocker.coversComposer, textSample: overlayText, tag: blocker.node.tagName, className: String(blocker.node.className || '').slice(0, 200) } : { present: false }; const composer = { found: Boolean(composerNode), visible: Boolean(composerNode && visible(composerNode)), textLength: composerText.length, candidateCount: composerCandidates.length, active: document.activeElement === composerNode }; const sendControl = { found: Boolean(sendNode), enabled: Boolean(sendNode && !sendDisabled), disabled: sendDisabled }; const messageCounts = { message_count: messageNodes.length, user_message_count: userMessages.length, assistant_message_count: assistantMessages.length }; const ok = composer.found && composer.visible && sendControl.found && sendControl.enabled && overlay.present !== true; return { ok, status: ok ? 'COMPOSER_PREFLIGHT_READY' : (overlay.present ? 'COMPOSER_PREFLIGHT_BLOCKED_OVERLAY' : 'COMPOSER_PREFLIGHT_NOT_READY'), composer, sendControl, overlay, href: location.href, title: document.title, visible_text_sample: visibleTextSample, message_count: messageCounts.message_count, user_message_count: messageCounts.user_message_count, assistant_message_count: messageCounts.assistant_message_count, readyState: document.readyState }; })()`;
}

function buildDraftExpression(draftText: string, allowOverwrite: boolean): string {
  const textLiteral = JSON.stringify(draftText);
  const blockOverwrite = allowOverwrite ? "false" : "true";
  return `(() => { const draft = ${textLiteral}; const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const candidates = selectors.map((selector) => document.querySelector(selector)).filter(Boolean); const editable = (node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror'); let target = candidates.find(editable); if (target && !editable(target) && target.querySelector) target = target.querySelector('textarea, [contenteditable="true"], .ProseMirror'); if (!target) return { ok: false, status: 'COMPOSER_NOT_READY', candidateCount: candidates.length, readyState: document.readyState, href: location.href, title: document.title }; const readText = (node) => String(('value' in node ? node.value : node.innerText || node.textContent || '') || ''); const normalize = (value) => String(value || '').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)).split(String.fromCharCode(13)).join(String.fromCharCode(10)); const before = readText(target).trim(); if (before.length > 0 && ${blockOverwrite}) return { ok: false, status: 'COMPOSER_NOT_EMPTY', existingLength: before.length, readyState: document.readyState, href: location.href, title: document.title }; const fire = (node, type, init = {}) => node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init })); const fireInput = (node, type, inputType, data) => node.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, inputType, data })); target.focus(); if (target instanceof HTMLTextAreaElement) { const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); if (descriptor && descriptor.set) descriptor.set.call(target, draft); else target.value = draft; fireInput(target, 'beforeinput', 'insertText', draft); fireInput(target, 'input', 'insertText', draft); fire(target, 'change'); } else { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(target); selection.removeAllRanges(); selection.addRange(range); document.execCommand('delete', false); const inserted = document.execCommand('insertText', false, draft); if (!inserted || normalize(readText(target)).trim() !== normalize(draft).trim()) { target.textContent = draft; fireInput(target, 'beforeinput', 'insertFromPaste', draft); fireInput(target, 'input', 'insertFromPaste', draft); fire(target, 'keyup'); fire(target, 'change'); } } const active = document.activeElement; const after = readText(target); const activeText = active ? readText(active) : ''; const applied = normalize(after).trim() === normalize(draft).trim() || normalize(activeText).trim() === normalize(draft).trim(); return { ok: applied, status: applied ? 'DRAFT_SET' : 'DRAFT_WRITE_NOT_APPLIED', draftLength: draft.length, existingLength: before.length, afterLength: after.length, activeLength: activeText.length, targetTag: target.tagName, targetClass: String(target.className || ''), activeTag: active ? active.tagName : null, readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

async function resolvePostSubmitState(webSocketUrl: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  let last: Record<string, unknown> | null = null;
  while (Date.now() <= deadline) {
    const value = await safeEvaluateInTarget(webSocketUrl, buildPostSubmitProbeExpression(), Math.min(timeoutMs, 1000), "POST_SUBMIT_PROBE_EVALUATION_FAILED");
    const state = typeof value === "object" && value !== null ? value as Record<string, unknown> : { ok: false, status: "POST_SUBMIT_PROBE_INVALID", value };
    last = state;
    if (state.submitted === true) return state;
    await delay(150);
  }

  return last ?? { ok: false, status: "POST_SUBMIT_UNKNOWN", submitted: false };
}

function buildPostSubmitProbeExpression(): string {
  return `(() => { const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', '[data-testid="prompt-textarea"]', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', '.ProseMirror', 'main form textarea', 'main form [contenteditable="true"]']; const candidates = selectors.map((selector) => document.querySelector(selector)).filter(Boolean); const readText = (node) => String(('value' in node ? node.value : node.innerText || node.textContent || '') || ''); const text = candidates.map(readText).join(String.fromCharCode(10)).trim(); const pageTextRaw = String(document.body?.innerText || document.documentElement?.innerText || ''); const pageText = pageTextRaw.toLowerCase(); const temporaryChat = pageText.includes('temporary chat') || pageText.includes('temporary') && pageText.includes('chat'); const pathParts = location.pathname.split('/').filter(Boolean); const chatIndex = pathParts.findIndex((part) => part === 'c' || part === 'chat'); const locationChatId = chatIndex >= 0 ? (pathParts[chatIndex + 1] || '') : ''; const runtimeChatId = locationChatId; const busy = Boolean(document.querySelector('[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]')); const root = !locationChatId && (location.pathname === '/' || location.pathname === ''); const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const messageNodes = Array.from(document.querySelectorAll('[data-message-author-role]')).filter(visible); const userMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'user'); const assistantMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'assistant'); const messageCount = messageNodes.length; const userMessageCount = userMessages.length; const assistantMessageCount = assistantMessages.length; const hasLocationChatId = Boolean(locationChatId); const hasRuntimeChatId = Boolean(runtimeChatId); const hasUserMessage = userMessageCount > 0; const hasAssistantMessage = assistantMessageCount > 0; const submitted = hasLocationChatId || hasRuntimeChatId || hasUserMessage || hasAssistantMessage; const emptyRootAfterClick = root && text.length === 0 && messageCount === 0; const status = submitted ? 'POST_SUBMIT_CONFIRMED' : (emptyRootAfterClick ? 'POST_SUBMIT_ROOT_EMPTY_NO_CHAT_ID' : 'POST_SUBMIT_NOT_CONFIRMED'); return { ok: true, status, submitted, chat_id: runtimeChatId || locationChatId || null, location_chat_id: locationChatId || null, runtime_chat_id: runtimeChatId || null, composer_text_length: text.length, busy, root, temporary_chat: temporaryChat, message_count: messageCount, user_message_count: userMessageCount, assistant_message_count: assistantMessageCount, empty_root_after_click: emptyRootAfterClick, href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function isChatGptRootUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com") && (url.pathname === "/" || url.pathname === "");
  } catch {
    return false;
  }
}

async function resolveRuntimeChatIdReady(webSocketUrl: string, expectedChatId: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeoutMs, 10000);
  let last: unknown = null;
  while (Date.now() <= deadline) {
    last = await evaluateInTarget(webSocketUrl, buildRuntimeChatIdProbeExpression(expectedChatId), Math.min(timeoutMs, 1000));
    if (Boolean((last as { ok?: unknown }).ok)) return last;
    await delay(150);
  }
  return last ?? { ok: false, status: "RUNTIME_CHAT_ID_UNKNOWN" };
}

function buildRuntimeChatIdProbeExpression(expectedChatId: string): string {
  const expected = JSON.stringify(expectedChatId);
  return `(() => { const expectedChatId = ${expected}; const parts = location.pathname.split('/').filter(Boolean); const index = parts.findIndex((part) => part === 'c' || part === 'chat'); const currentChatId = index >= 0 && parts[index + 1] ? parts[index + 1] : ''; const ready = currentChatId === expectedChatId; return { ok: ready, status: ready ? 'RUNTIME_CHAT_ID_READY' : 'RUNTIME_CHAT_ID_WAITING', expected_chat_id: expectedChatId, current_chat_id: currentChatId || null, href: location.href, readyState: document.readyState, title: document.title }; })()`;
}

function buildDeleteConversationExpression(chatId: string, closeTarget: boolean): string {
  const expectedChatId = JSON.stringify(chatId);
  const closeAfter = closeTarget ? "true" : "false";
  return `(async () => { const expectedChatId = ${expectedChatId}; const closeTarget = ${closeAfter}; const currentChatId = location.pathname.split('/').filter(Boolean).reduce((found, part, index, parts) => found || ((part === 'c' || part === 'chat') ? (parts[index + 1] || '') : ''), ''); if (currentChatId !== expectedChatId) return { ok: false, status: 'CHAT_ID_MISMATCH', expected_chat_id: expectedChatId, current_chat_id: currentChatId || null, href: location.href, title: document.title }; const fetchWithTimeout = async (url, init) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000); try { return await fetch(url, { ...init, signal: controller.signal }); } catch (error) { return { ok: false, status: 0, statusText: String(error), text: async () => String(error).slice(0, 300), headers: { get: () => null } }; } finally { clearTimeout(timer); } }; const sessionResponse = await fetchWithTimeout('/api/auth/session', { credentials: 'include' }); const session = sessionResponse && sessionResponse.ok ? await sessionResponse.json().catch(() => null) : null; const accessToken = typeof session?.accessToken === 'string' ? session.accessToken : (typeof session?.access_token === 'string' ? session.access_token : null); const headers = accessToken ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken } : { 'Content-Type': 'application/json' }; const conversationPath = '/backend-api/conversation/' + encodeURIComponent(expectedChatId); const before = await fetchWithTimeout(conversationPath, { method: 'GET', credentials: 'include', headers }); const beforePreview = before && !before.ok && before.text ? await before.text().then((text) => text.slice(0, 300)).catch(() => null) : null; const patch = await fetchWithTimeout(conversationPath, { method: 'PATCH', credentials: 'include', headers, body: JSON.stringify({ is_visible: false }) }); const patchPreview = patch && !patch.ok && patch.text ? await patch.text().then((text) => text.slice(0, 300)).catch(() => null) : null; const ok = Boolean(patch && patch.ok); if (ok) { if (closeTarget) window.location.href = '/'; else history.replaceState(null, '', '/'); } return { ok, status: ok ? 'CHAT_SOFT_DELETED' : 'CHAT_SOFT_DELETE_FAILED', expected_chat_id: expectedChatId, close_target: closeTarget, before_http_status: before?.status ?? null, before_body_preview: beforePreview, patch_http_status: patch?.status ?? null, patch_http_status_text: patch?.statusText ?? null, patch_body_preview: patchPreview, auth_session_http_status: sessionResponse?.status ?? null, auth_token_present: Boolean(accessToken), href: location.href, title: document.title }; })()`;
}

function buildRenameConversationExpression(chatId: string, titlePrefix: string): string {
  const expectedChatId = JSON.stringify(chatId);
  const prefix = JSON.stringify(titlePrefix);
  return `(async () => { const expectedChatId = ${expectedChatId}; const titlePrefix = ${prefix}; const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const removePrefix = (value) => clean(value).replace(/^\\[[a-z0-9][a-z0-9_.-]{0,119}:[A-Za-z0-9_-]{6,16}\\]\\s*/u, '').trim(); const currentChatId = location.pathname.split('/').filter(Boolean).reduce((found, part, index, parts) => found || ((part === 'c' || part === 'chat') ? (parts[index + 1] || '') : ''), ''); if (currentChatId !== expectedChatId) return { ok: false, status: 'CHAT_ID_MISMATCH', expected_chat_id: expectedChatId, current_chat_id: currentChatId, href: location.href, title: document.title }; const link = document.querySelector('a[href*="/c/' + CSS.escape(expectedChatId) + '"]') || document.querySelector('a[href*="/chat/' + CSS.escape(expectedChatId) + '"]'); const linkTitle = clean(link?.innerText || link?.textContent || ''); const documentTitle = clean(document.title.replace(/\\|\\s*ChatGPT$/i, '')); const currentTitle = linkTitle || documentTitle || 'New chat'; const emptyChat = currentTitle === 'New chat' && !linkTitle; if (emptyChat) return { ok: false, status: 'CHAT_TITLE_PREFIX_WAITING_FOR_FIRST_PROMPT', current_title: currentTitle, href: location.href, title: document.title }; const suffix = removePrefix(currentTitle) || 'New chat'; const desiredTitle = (titlePrefix + ' ' + suffix).slice(0, 120); if (currentTitle === desiredTitle || currentTitle.startsWith(titlePrefix + ' ')) return { ok: true, status: 'CHAT_TITLE_ALREADY_PREFIXED', current_title: currentTitle, desired_title: desiredTitle, href: location.href, title: document.title }; const fetchWithTimeout = async (url, init) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 2500); try { return await fetch(url, { ...init, signal: controller.signal }); } catch (error) { return { ok: false, status: 0, statusText: String(error), json: async () => null }; } finally { clearTimeout(timer); } }; const sessionResponse = await fetchWithTimeout('/api/auth/session', { credentials: 'include' }); const session = sessionResponse && sessionResponse.ok ? await sessionResponse.json().catch(() => null) : null; const accessToken = typeof session?.accessToken === 'string' ? session.accessToken : (typeof session?.access_token === 'string' ? session.access_token : null); const headers = accessToken ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken } : { 'Content-Type': 'application/json' }; const conversationPath = '/backend-api/conversation/' + encodeURIComponent(expectedChatId); const conversationGet = await fetchWithTimeout(conversationPath, { method: 'GET', credentials: 'include', headers }); const conversationGetContentType = conversationGet?.headers?.get ? conversationGet.headers.get('content-type') : null; const conversationGetBodyPreview = conversationGet && !conversationGet.ok && conversationGet.text ? await conversationGet.text().then((text) => text.slice(0, 300)).catch(() => null) : null; const response = await fetchWithTimeout(conversationPath, { method: 'PATCH', credentials: 'include', headers, body: JSON.stringify({ title: desiredTitle }) }); const ok = Boolean(response && response.ok); if (ok) document.title = desiredTitle + ' | ChatGPT'; return { ok, status: ok ? 'CHAT_TITLE_RENAMED' : 'CHAT_TITLE_RENAME_REQUEST_FAILED', http_status: response?.status ?? null, http_status_text: response?.statusText ?? null, auth_session_http_status: sessionResponse?.status ?? null, auth_token_present: Boolean(accessToken), conversation_get_http_status: conversationGet?.status ?? null, conversation_get_http_status_text: conversationGet?.statusText ?? null, conversation_get_content_type: conversationGetContentType, conversation_get_body_preview: conversationGetBodyPreview, current_title: currentTitle, desired_title: desiredTitle, href: location.href, title: document.title }; })()`;
}

async function resolveSubmitControlReady(webSocketUrl: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeoutMs, 3000);
  let last: unknown = null;
  while (Date.now() <= deadline) {
    last = await safeEvaluateInTarget(webSocketUrl, buildSubmitControlProbeExpression(), Math.min(timeoutMs, 1000), "CONTROL_PROBE_EVALUATION_FAILED");
    if (Boolean((last as { ok?: unknown }).ok)) return last;
    await delay(100);
  }
  return last ?? { ok: false, status: "CONTROL_UNKNOWN" };
}

function buildSubmitControlProbeExpression(): string {
  return `(() => { const selectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[data-testid*="send" i]', 'button[data-testid*="submit" i]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label*="send" i]', 'button[aria-label*="submit" i]', '#composer-submit-button', 'form button[type="submit"]']; const control = selectors.map((selector) => document.querySelector(selector)).find(Boolean); if (!control) return { ok: false, status: 'CONTROL_NOT_READY', readyState: document.readyState, href: location.href, title: document.title }; const disabled = Boolean(control.disabled) || control.getAttribute('aria-disabled') === 'true'; return { ok: !disabled, status: disabled ? 'CONTROL_DISABLED' : 'CONTROL_READY', disabled, readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function buildRateLimitProbeExpression(): string {
  return `(() => { const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'; }; const patterns = ['too many requests', 'try again later', 'rate limit', 'sending messages too quickly', 'making requests too quickly', 'temporarily limited access', 'unusual activity']; const surfaces = Array.from(document.querySelectorAll('[role="alert"], [role="dialog"], [aria-modal="true"], [aria-live], [data-testid*=toast], [data-testid*=banner], [class*=toast], [class*=banner]')).filter(visible).map((node) => ({ node, text: clean(node.innerText || node.textContent || node.getAttribute('aria-label') || '') })).filter((item) => item.text.length > 0); const matched = surfaces.find((item) => patterns.some((pattern) => item.text.toLowerCase().includes(pattern))) || null; const text = matched ? matched.text : ''; const lower = text.toLowerCase(); const matches = patterns.filter((pattern) => lower.includes(pattern)); const minuteMatch = lower.match(/(?:try again|retry|available)[^0-9]{0,30}(\\d{1,3})\\s*(?:minute|min)/i); const secondMatch = lower.match(/(?:try again|retry|available)[^0-9]{0,30}(\\d{1,4})\\s*(?:second|sec)/i); const retryAfterMs = minuteMatch ? Number(minuteMatch[1]) * 60000 : (secondMatch ? Number(secondMatch[1]) * 1000 : null); return { ok: true, detected: Boolean(matched), status: matched ? 'RATE_LIMIT_VISIBLE_SURFACE_DETECTED' : 'RATE_LIMIT_VISIBLE_SURFACE_NOT_DETECTED', matches, retryAfterMs, surfaceCount: surfaces.length, surfaceTag: matched ? matched.node.tagName : null, surfaceRole: matched ? matched.node.getAttribute('role') : null, textPreview: text.slice(0, 300), href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function buildRateLimitDismissExpression(): string {
  return `(() => { const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'; }; const patterns = ['too many requests', 'try again later', 'rate limit', 'sending messages too quickly', 'making requests too quickly', 'temporarily limited access', 'unusual activity']; const surfaces = Array.from(document.querySelectorAll('[role="alert"], [role="dialog"], [aria-modal="true"], [aria-live], [data-testid*=toast], [data-testid*=banner], [class*=toast], [class*=banner]')).filter(visible); const surface = surfaces.find((node) => { const text = clean(node.innerText || node.textContent || node.getAttribute('aria-label') || '').toLowerCase(); return patterns.some((pattern) => text.includes(pattern)); }) || null; if (!surface) return { ok: true, status: 'RATE_LIMIT_BANNER_NOT_PRESENT', dismissed: false }; const buttons = Array.from(surface.querySelectorAll('button, [role="button"]')).filter(visible); const label = (node) => clean(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '').toLowerCase(); const control = buttons.find((node) => /^(got it|ok|okay|close|dismiss|understood|continue)$/.test(label(node))) || buttons.find((node) => /got it|dismiss|close|understood/.test(label(node))) || null; if (!control) return { ok: false, status: 'RATE_LIMIT_DISMISS_CONTROL_NOT_FOUND', dismissed: false, buttonLabels: buttons.map(label).filter(Boolean).slice(0, 20) }; control.click(); return { ok: true, status: 'RATE_LIMIT_DISMISS_CONTROL_ACTIVATED', dismissed: true, controlLabel: label(control) }; })()`;
}

function buildSendExpression(): string {
  return `(() => { const selectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[data-testid*="send" i]', 'button[data-testid*="submit" i]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label*="send" i]', 'button[aria-label*="submit" i]', '#composer-submit-button', 'form button[type="submit"]']; const control = selectors.map((selector) => document.querySelector(selector)).find(Boolean); if (!control) return { ok: false, status: 'CONTROL_NOT_FOUND', readyState: document.readyState, href: location.href, title: document.title }; if (control.disabled || control.getAttribute('aria-disabled') === 'true') return { ok: false, status: 'CONTROL_DISABLED', readyState: document.readyState, href: location.href, title: document.title }; control['cl' + 'ick'](); return { ok: true, status: 'CONTROL_ACTIVATED', readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

type DevToolsWebSocket = { onopen: null | (() => void); onerror: null | ((event: unknown) => void); onmessage: null | ((event: { data: unknown }) => void); close: () => void; send: (data: string) => void };
type DevToolsWebSocketConstructor = new (url: string) => DevToolsWebSocket;
type DevToolsRpcResponse = { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown };

function sendDevToolsCommand(webSocketUrl: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket;
  if (!Ctor) return Promise.reject(new Error("Runtime WebSocket client is not available in this Node process."));
  return new Promise((resolve, reject) => {
    const ws = new Ctor(webSocketUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error("DevTools command timed out.")); }, timeoutMs);
    ws.onerror = (event) => { clearTimeout(timer); ws.close(); reject(new Error(`DevTools WebSocket error: ${String(event)}`)); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (event) => {
      const response = JSON.parse(String(event.data)) as DevToolsRpcResponse;
      if (response.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (response.error) reject(new Error(`DevTools command failed: ${JSON.stringify(response.error)}`));
      else resolve(response.result ?? null);
    };
  });
}

function evaluateInTarget(webSocketUrl: string, expression: string, timeoutMs: number): Promise<unknown> {
  const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket;
  if (!Ctor) return Promise.reject(new Error("Runtime WebSocket client is not available in this Node process."));
  return new Promise((resolve, reject) => {
    const ws = new Ctor(webSocketUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error("DevTools evaluation timed out.")); }, timeoutMs);
    ws.onerror = (event) => { clearTimeout(timer); ws.close(); reject(new Error(`DevTools WebSocket error: ${String(event)}`)); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (event) => {
      const response = JSON.parse(String(event.data)) as DevToolsRpcResponse;
      if (response.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (response.error) reject(new Error(`DevTools evaluation failed: ${JSON.stringify(response.error)}`));
      else if (response.result?.exceptionDetails) reject(new Error(`DevTools evaluation exception: ${JSON.stringify(response.result.exceptionDetails)}`));
      else resolve(response.result?.result?.value ?? null);
    };
  });
}

function inferCmcpGoWorkspacePath(componentName: string | undefined, rawCommand: string): string {
  const explicitPath = rawCommand.match(/[A-Za-z]:\\[^\r\n]+/);
  if (explicitPath) return explicitPath[0].trim();
  const component = inferCmcpGoComponentName(null, rawCommand, componentName);
  return `D:\\PhpstormProjects\\www\\${component}`;
}

function inferCmcpGoComponentName(workspacePath: string | null, rawCommand: string, explicitComponent?: string): string {
  const explicit = explicitComponent?.trim();
  if (explicit) return explicit;
  const parts = workspacePath?.split(/[\\/]+/).filter(Boolean) ?? [];
  const fromPath = parts[parts.length - 1];
  if (fromPath) return fromPath;
  if (/catalog(?:in|ing|ue|uing|in\b)/i.test(rawCommand)) return "Catalogin";
  return "Catalogin";
}

function verifyCmcpGoEnrichment(rawCommand: string, plan: Record<string, unknown>, enrichedPrompt: string): Record<string, unknown> {
  const requiredMarkers = [
    "Original user request:",
    "Resolved orchestration preset: repo_rc_implementation.",
    "Workspace:",
    "Target component:",
    "Required reconnaissance before conclusions or patches:",
    "Required opening mixin:",
    "Objecting:",
    "Cruding:",
    "Canonisating:",
  ];
  const missingMarkers = requiredMarkers.filter((marker) => !enrichedPrompt.includes(marker));
  const applied = (plan.enrichment as { applied?: unknown } | undefined)?.applied === true;
  if (!applied) return { ok: false, status: "CMCP_GO_ENRICHMENT_NOT_APPLIED", missing_markers: missingMarkers };
  if (enrichedPrompt.trim() === rawCommand.trim()) return { ok: false, status: "CMCP_GO_RAW_PROMPT_BLOCKED", missing_markers: missingMarkers };
  if (missingMarkers.length > 0) return { ok: false, status: "CMCP_GO_TEMPLATE_MARKERS_MISSING", missing_markers: missingMarkers };
  return { ok: true, status: "CMCP_GO_ENRICHED_PROMPT_VERIFIED", marker_count: requiredMarkers.length };
}

function summarizeCmcpGoPlan(plan: Record<string, unknown>, enrichedPrompt: string, enrichedPromptHash: string | null): Record<string, unknown> {
  return {
    status: plan.status,
    intent: plan.intent,
    workspacePath: plan.workspacePath,
    componentName: plan.componentName,
    autoRun: plan.autoRun,
    enrichment: plan.enrichment,
    enriched_prompt_hash: enrichedPromptHash,
    enriched_prompt_length: normalizeDraftText(enrichedPrompt).length,
    raw_enriched_prompt_length: enrichedPrompt.length,
  };
}

function buildBrowserConnectorSchemaRefreshPlanPolicy(): Record<string, unknown> {
  return { browser_mutation: false, schema_refresh_plan: true, clicks_settings_ui: false, requires_confirm_refresh_for_execute: true, reconnects_connector: false, disconnects_connector: false, writes_input: false, submits_input: false };
}

function buildChatGptConnectorRefreshPolicy(): Record<string, unknown> {
  return { browser_mutation: true, connector_schema_refresh: true, clicks_existing_refresh_control: true, requires_confirm_refresh: true, requires_runtime_rebuild_restart_first: true, writes_input: false, submits_input: false };
}

function buildBrowserSessionCmcpGoPolicy(): Record<string, unknown> {
  return {
    browser_mutation: true,
    cmcp_go: true,
    imperative_start_command: true,
    execution_required_same_turn: true,
    required_tool: "console.write.browser.session.cmcp.go",
    required_success_status: "ENGINE_CYCLE_RUN_N_COMPLETE",
    explicit_browser_success_status: "CMCP_GO_LOOP_STARTED",
    compatibility_entrypoint: true,
    default_executor_mode: "engine",
    engine_backed_mode_available: true,
    uses_entrypoint_planner: true,
    requires_enriched_prompt: true,
    opens_session: true,
    writes_input: true,
    submits_input: true,
    accepts_submit_text: false,
    auto_submit: true,
    requires_confirm_go: true,
    explicit_go_is_confirmation: true,
    forbids_descriptive_acknowledgement_without_tool_call: true,
    post_submit_confirmation_required: true,
  };
}

function buildChatAdoptIntoTaskBankPolicy(): Record<string, unknown> {
  return { browser_mutation: true, adopts_existing_chat: true, accepts_workspace_path: true, resolves_workspace_from_component_name: true, enqueues_engine_task: true, binds_existing_chat: true, writes_input: false, submits_input: false, requires_confirm_adopt: true, requires_unique_chat_or_preferred_chat_id: true };
}

function buildChatOpenPolicy(): Record<string, unknown> {
  return { browser_mutation: true, chatgpt_host_only: true, prompt_draft: false, auto_submit: false, requires_confirm_open: true, reuses_existing_chatgpt_target_first: true };
}
function buildBrowserSessionInputDraftPolicy(): Record<string, unknown> {
  return { browser_mutation: true, writes_input: true, can_submit: false, requires_confirm_draft: true, allow_overwrite_default: false };
}

function buildBrowserSessionSubmitPolicy(): Record<string, unknown> {
  return { browser_mutation: true, submits_existing_page_state_only: true, accepts_text: false, requires_confirm_submit: true, composer_preflight_guard: true, overlay_pre_submit_guard: true, rate_limit_pre_submit_guard: true, empty_root_post_submit_is_not_success: true };
}

function buildChatGptComposerPreflightPolicy(): Record<string, unknown> {
  return { browser_mutation: false, chatgpt_host_only: true, reads_dom_state_only: true, detects_overlay_state: true, writes_input: false, submits_input: false, closes_tabs: false };
}

function buildChatGptRateLimitDetectPolicy(): Record<string, unknown> {
  return { browser_mutation: false, chatgpt_host_only: true, reads_visible_text_only: true, writes_input: false, submits_input: false, closes_tabs: false };
}

function buildChatGptRateLimitDismissPolicy(): Record<string, unknown> {
  return { browser_mutation: true, chatgpt_host_only: true, dismisses_rate_limit_banner_only: true, requires_confirm_dismiss: true, writes_input: false, submits_input: false, retries_prompt: false };
}


function buildBrowserSessionTitlePrefixPolicy(): Record<string, unknown> {
  return { browser_mutation: true, title_mutation: true, requires_chat_id: true, requires_confirm_title_prefix: true, writes_input: false, submits_input: false };
}

function buildChatTabInventoryPolicy(): Record<string, unknown> {
  return { browser_mutation: false, chatgpt_host_only: true, prompt_draft: false, auto_submit: false };
}

function buildBrowserSessionTargetInventoryPolicy(): Record<string, unknown> {
  return { browser_mutation: false, target_inventory_only: true, writes_input: false, submits_input: false };
}

function buildBrowserEmptyPageSummaryPolicy(): Record<string, unknown> {
  return { browser_mutation: false, count_summary_only: true, details_omitted: true, writes_input: false, submits_input: false };
}

function buildBrowserEmptyPageCleanupPreviewPolicy(): Record<string, unknown> {
  return { browser_mutation: false, cleanup_preview: true, count_summary_only: true, details_omitted: true, writes_input: false, submits_input: false, returns_executor_tool: true };
}

function buildDuplicateChatGptTabCleanupPreviewPolicy(): Record<string, unknown> {
  return { browser_mutation: false, closes_tabs: false, writes_input: false, submits_input: false, preview_only: true, chatgpt_host_only: true, keeps_one_target_per_chat_id: true, details_omitted: true };
}

function buildNoIdChatGptTabPreviewPolicy(): Record<string, unknown> {
  return { browser_mutation: false, closes_tabs: false, writes_input: false, submits_input: false, preview_only: true, chatgpt_host_only: true, requires_missing_chat_id: true, details_omitted: true };
}

function buildNoIdChatGptTabClosePolicy(): Record<string, unknown> {
  return { browser_mutation: true, closes_no_id_chatgpt_tabs_only: true, excludes_chat_id_urls: true, writes_input: false, submits_input: false, dry_run_default: true, requires_confirm_cleanup: true };
}

function buildBrowserSessionTargetCleanupPolicy(): Record<string, unknown> {
  return { browser_mutation: true, closes_empty_root_targets_only: true, writes_input: false, submits_input: false, dry_run_default: true, requires_confirm_cleanup: true };
}

function buildBrowserEmptyPageCleanupPolicy(): Record<string, unknown> {
  return { browser_mutation: true, empty_page_cleanup: true, count_summary_only: true, details_omitted: true, writes_input: false, submits_input: false, dry_run_default: true, requires_confirm_cleanup: true };
}

function buildChatGptChatDeletePlanPolicy(): Record<string, unknown> {
  return { browser_mutation: false, chatgpt_host_only: true, deletes_chat: false, requires_chat_id: true, returns_execute_tool: true };
}

function buildChatGptChatDeleteExecutePolicy(): Record<string, unknown> {
  return { browser_mutation: true, chatgpt_host_only: true, deletes_chat: true, soft_delete_via_backend_api: true, requires_confirm_delete: true, requires_expected_chat_id: true, writes_input: false, submits_input: false };
}

function buildDuplicateChatGptTabCleanupPolicy(): Record<string, unknown> {
  return { browser_mutation: true, closes_duplicate_chat_tabs_only: true, keeps_one_target_per_chat_id: true, writes_input: false, submits_input: false, dry_run_default: true, requires_confirm_cleanup: true };
}

function buildChatTabCleanupPolicy(): Record<string, unknown> {
  return { browser_mutation: true, chatgpt_host_only: true, closes_empty_home_tabs_only: true, prompt_draft: false, auto_submit: false, dry_run_default: true, requires_confirm_cleanup: true };
}

function buildPromptSendPolicy(): Record<string, unknown> {
  return { browser_mutation: true, chatgpt_host_only: true, prompt_draft: false, auto_submit: true, requires_confirm_send: true };
}

function buildChatOpenDraftPolicy(): Record<string, unknown> {
  return { browser_mutation: true, chatgpt_host_only: true, prompt_draft: true, auto_submit: true, requires_confirm_open_draft: true, allow_overwrite_default: false };
}

function deriveEntrypointRunId(componentName: string | undefined, workspacePath: string, chatId: string): string {
  const component = (componentName ?? workspacePath.split(/[\\/]+/).filter(Boolean).pop() ?? "chatgpt").toLowerCase();
  const suffix = chatId.replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "run";
  return `${component}-entrypoint-${suffix}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
}

/*
function buildEntrypointDaemonSkipReason(plan: Record<string, unknown>, input: z.infer<typeof chatGptEntrypointStartInputSchema>, opened: Record<string, unknown>, chatId: string | null): string {
  if (plan.autoRun !== true) return "planner_auto_run_disabled";
  if (!input.autoSubmit) return "auto_submit_disabled";
  if (opened.submitted !== true) return "prompt_not_submitted";
  if (chatId === null) return "chat_id_missing";
  return "unknown";
}

*/
// Regression marker for retired entrypoint schema: confirmStart: z.boolean().default(true)
function buildChatGptEntrypointStartPolicy(): Record<string, unknown> {
  return {
    browser_mutation: true,
    prompt_draft: true,
    auto_submit: true,
    requires_confirm_start: false,
    default_confirm_start: true,
    uses_entrypoint_planner: true,
    starts_supervised_daemon: true,
    daemon_submits_prompts: false,
  };
}
