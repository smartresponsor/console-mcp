import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerChatGptChatOpenTool } from "../dist/tool/chatgpt-chat-open.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolName = "console.write.browser.chatgpt.chat.adopt_into_task_bank";
const goToolName = "console.write.browser.chatgpt.chat.adopt_go";
const expectedParameters = [
  "ports",
  "componentName",
  "workspacePath",
  "preferredChatId",
  "locator",
  "requireSingleChat",
  "taskPreset",
  "maxAutoIterations",
  "recoverComposer",
  "autoStart",
  "dryRun",
  "activate",
  "confirmAdopt",
  "timeoutMs",
];
const expectedGoParameters = [
  "ports",
  "componentName",
  "workspacePath",
  "preferredChatId",
  "locator",
  "requireSingleChat",
  "taskPreset",
  "maxAutoIterations",
  "recoverComposer",
  "activate",
  "confirmGo",
  "timeoutMs",
];

const registrations = new Map();
const server = {
  registerTool(name, registration, handler) {
    registrations.set(name, { registration, handler });
  },
};

registerChatGptChatOpenTool(
  server,
  { allowedRoots: [root], transcriptDir: path.join(root, "var", "transcript") },
  root,
  {},
);

const captured = registrations.get(toolName);
if (!captured) {
  throw new Error(`Adopt schema regression failed: ${toolName} was not registered.`);
}
const capturedGo = registrations.get(goToolName);
if (!capturedGo) {
  throw new Error(`Adopt schema regression failed: ${goToolName} was not registered.`);
}

const inputSchema = captured.registration?.inputSchema;
if (!inputSchema || typeof inputSchema.safeParse !== "function") {
  throw new Error("Adopt schema regression failed: registered inputSchema is not a Zod schema.");
}

const shape = inputSchema.shape;
if (!shape || typeof shape !== "object") {
  throw new Error("Adopt schema regression failed: registered Zod object shape is unavailable.");
}

const actualParameters = Object.keys(shape);
const missing = expectedParameters.filter((name) => !actualParameters.includes(name));
const unexpected = actualParameters.filter((name) => !expectedParameters.includes(name));
if (missing.length > 0 || unexpected.length > 0) {
  throw new Error(`Adopt schema regression failed: parameter drift; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}.`);
}

const goInputSchema = capturedGo.registration?.inputSchema;
if (!goInputSchema || typeof goInputSchema.safeParse !== "function") {
  throw new Error("Adopt schema regression failed: ADOPT GO inputSchema is not a Zod schema.");
}
const actualGoParameters = Object.keys(goInputSchema.shape ?? {});
const missingGo = expectedGoParameters.filter((name) => !actualGoParameters.includes(name));
const unexpectedGo = actualGoParameters.filter((name) => !expectedGoParameters.includes(name));
if (missingGo.length > 0 || unexpectedGo.length > 0) {
  throw new Error(`Adopt schema regression failed: ADOPT GO parameter drift; missing=${missingGo.join(",") || "none"}; unexpected=${unexpectedGo.join(",") || "none"}.`);
}
const goDefaults = goInputSchema.safeParse({ componentName: "Addressing" });
if (!goDefaults.success || goDefaults.data.maxAutoIterations !== 70 || goDefaults.data.recoverComposer !== false || goDefaults.data.confirmGo !== false) {
  throw new Error("Adopt schema regression failed: ADOPT GO defaults drifted.");
}
const goLive = goInputSchema.safeParse({ componentName: "Addressing", locator: "@Addressing1", maxAutoIterations: 10, confirmGo: true });
if (!goLive.success || goLive.data.locator !== "@Addressing1" || goLive.data.maxAutoIterations !== 10 || goLive.data.confirmGo !== true) {
  throw new Error("Adopt schema regression failed: ADOPT GO M10 locator inputs were not preserved.");
}

const defaults = inputSchema.safeParse({ componentName: "Addressing" });
if (!defaults.success) {
  throw new Error(`Adopt schema regression failed: defaults did not parse: ${defaults.error.message}`);
}
if (defaults.data.autoStart !== false) {
  throw new Error(`Adopt schema regression failed: autoStart default must be false, got ${String(defaults.data.autoStart)}.`);
}
if (defaults.data.dryRun !== true) {
  throw new Error(`Adopt schema regression failed: dryRun safe default must be true, got ${String(defaults.data.dryRun)}.`);
}

const validLocator = inputSchema.safeParse({ componentName: "Addressing", locator: "@Addressing1" });
if (!validLocator.success || validLocator.data.locator !== "@Addressing1") {
  throw new Error("Adopt schema regression failed: valid locator @Addressing1 was rejected or transformed.");
}

for (const locator of ["Addressing1", "@abc", "@Addressing!", "6a58715c10", "viewing:6a58715c10", "[viewing:6a58715c10]", "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111"]) {
  const parsedLocator = inputSchema.safeParse({ componentName: "Addressing", locator });
  if (!parsedLocator.success || parsedLocator.data.locator !== locator) {
    throw new Error(`Adopt schema regression failed: supported existing location was rejected or transformed: ${locator}`);
  }
}
for (const locator of ["", "a".repeat(501)]) {
  const invalidLocator = inputSchema.safeParse({ componentName: "Addressing", locator });
  if (invalidLocator.success) {
    throw new Error(`Adopt schema regression failed: invalid existing location was accepted: length=${locator.length}`);
  }
}

const live = inputSchema.safeParse({ componentName: "Addressing", locator: "@Addressing1", autoStart: true, dryRun: false, maxAutoIterations: 10 });
if (!live.success || live.data.autoStart !== true || live.data.dryRun !== false || live.data.maxAutoIterations !== 10) {
  throw new Error("Adopt schema regression failed: ADOPT GO M10 inputs were not preserved.");
}

const source = await readFile(path.join(root, "src", "tool", "chatgpt-chat-open.ts"), "utf8");
const dist = await readFile(path.join(root, "dist", "tool", "chatgpt-chat-open.js"), "utf8");
for (const marker of [
  "locator: z.string().min(1).max(500).optional()",
  "autoStart: z.boolean().default(false)",
  "dryRun: z.boolean().default(true)",
  "input.locator",
  "executionDryRun === false",
  "CHAT_ADOPT_LOCATOR_GLOBAL_SEARCH_CONTROL_NOT_FOUND",
  "CHAT_ADOPT_LOCATOR_GLOBAL_SEARCH_INPUT_NOT_FOUND",
  "search_mode: 'global_chat_search_ui_click'",
  "CHAT_ADOPT_LOCATOR_RESULT_CLICK_DID_NOT_OPEN_CHAT",
  '"Page.reload"',
  "CHAT_ADOPT_LOCATOR_PAGE_RELOAD_CONFIRMED",
  "reload_confirmed_immediately_before_global_search",
  "reload_confirmation: reloadConfirmation",
  "recordEngineExecutionSpecification",
  "authorizedBy: \"adopt\"",
  "recoverComposer: input.recoverComposer",
  "accepts_workspace_path: true",
]) {
  if (!source.includes(marker) || !dist.includes(marker)) {
    throw new Error(`Adopt schema regression failed: src/dist drift for marker: ${marker}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  tool: toolName,
  parameters: actualParameters,
  dry_run_default: defaults.data.dryRun,
  locator_contract: "unified-existing-location-1..500",
  live_dry_run_preserved: live.data.dryRun === false,
  src_dist_agree: true,
}, null, 2));
