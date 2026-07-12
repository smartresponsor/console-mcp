import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerChatGptChatOpenTool } from "../dist/tool/chatgpt-chat-open.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolName = "console.write.browser.chatgpt.chat.adopt_into_task_bank";
const expectedParameters = [
  "ports",
  "componentName",
  "preferredChatId",
  "locator",
  "requireSingleChat",
  "taskPreset",
  "maxAutoIterations",
  "autoStart",
  "dryRun",
  "activate",
  "confirmAdopt",
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

for (const locator of ["Addressing1", "@abc", "@Addressing!", `@${"a".repeat(33)}`]) {
  const invalidLocator = inputSchema.safeParse({ componentName: "Addressing", locator });
  if (invalidLocator.success) {
    throw new Error(`Adopt schema regression failed: invalid locator was accepted: ${locator}`);
  }
}

const live = inputSchema.safeParse({ componentName: "Addressing", locator: "@Addressing1", autoStart: true, dryRun: false, maxAutoIterations: 10 });
if (!live.success || live.data.autoStart !== true || live.data.dryRun !== false || live.data.maxAutoIterations !== 10) {
  throw new Error("Adopt schema regression failed: ADOPT GO M10 inputs were not preserved.");
}

const source = await readFile(path.join(root, "src", "tool", "chatgpt-chat-open.ts"), "utf8");
const dist = await readFile(path.join(root, "dist", "tool", "chatgpt-chat-open.js"), "utf8");
for (const marker of [
  "locator: z.string().regex(/^@[A-Za-z0-9_-]{4,32}$/).optional()",
  "autoStart: z.boolean().default(false)",
  "dryRun: z.boolean().default(true)",
  "input.locator",
  "executionDryRun === false",
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
  locator_pattern: "^@[A-Za-z0-9_-]{4,32}$",
  live_dry_run_preserved: live.data.dryRun === false,
  src_dist_agree: true,
}, null, 2));
