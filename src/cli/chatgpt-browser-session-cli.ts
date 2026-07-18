import { readFile } from "node:fs/promises";
import {
  captureMessages,
  inspectAuthStatus,
  inspectSessionWarmth,
  pruneRootTargets,
  repairSessionWarmth,
  renameLatestConversation,
  traceChatGptRenameNetwork,
  draftInput,
  inspectComposerPreflight,
  inventoryChatGptTargets,
  selectCleanChatGptRootTarget,
  sendPrompt,
  sendPromptFileAttachment,
  sendSmoke,
  sanitizeForOutput,
  submitDraft,
} from "../service/browser-session-executor.js";
import { cleanupChatGptPluginSettingsTargets, previewChatGptPluginSettingsTargets } from "../service/chatgpt-plugin-settings-cleaner.js";

type CliOptions = {
  ports?: number[];
  timeoutMs?: number;
  durationMs?: number;
  maxClose?: number;
  targetId?: string;
  chatId?: string;
  title?: string;
  allowOverwrite?: boolean;
  allowGuestRootSession?: boolean;
  profileDir?: string;
  keepTargetId?: string;
  confirmCleanup?: boolean;
  confirmRepair?: boolean;
  dryRun?: boolean;
  confirmSend?: boolean;
  confirmSubmit?: boolean;
  prompt?: string;
  promptFile?: string;
  promptTransport?: "INLINE_TEXT" | "FILE_ATTACHMENT";
  stdin?: boolean;
};

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  try {
    switch (command) {
      case "chatgpt-inventory":
      case "inventory":
        return printJson(await inventoryChatGptTargets(options));
      case "chatgpt-preflight":
      case "preflight":
        return printJson(await inspectComposerPreflight(options));
      case "chatgpt-auth-status":
      case "auth-status":
        return printJson(await inspectAuthStatus(options));
      case "chatgpt-session-warmth":
      case "session-warmth":
        return printJson(await inspectSessionWarmth(options));
      case "chatgpt-prune-root-targets":
      case "prune-root-targets":
        return printJson(await pruneRootTargets(options));
      case "chatgpt-session-warmth-repair":
      case "session-warmth-repair":
        return printJson(await repairSessionWarmth(options));
      case "chatgpt-plugin-settings-cleanup-preview":
      case "plugin-settings-cleanup-preview":
        return printJson(await previewChatGptPluginSettingsTargets(options));
      case "chatgpt-plugin-settings-cleanup":
      case "plugin-settings-cleanup":
        if (options.confirmCleanup !== true) {
          process.exitCode = 2;
          return printJson({ ok: false, status: "CONFIRM_CLEANUP_REQUIRED", next_action: "rerun with --confirm-cleanup" });
        }
        return printJson(await cleanupChatGptPluginSettingsTargets(options));
      case "chatgpt-rename-latest":
      case "rename-latest":
        return printJson(await renameLatestConversation({ ...options, title: options.title ?? "" }));
      case "chatgpt-trace-rename-network":
      case "trace-rename-network":
        return printJson(await traceChatGptRenameNetwork(options));
      case "chatgpt-draft":
      case "draft":
        return printJson(await draftInput({ ...options, prompt: await readPrompt(options) }));
      case "chatgpt-submit":
      case "submit":
        return printJson(await submitDraft({ ...options, confirmSubmit: options.confirmSubmit === true }));
      case "chatgpt-send":
      case "send":
        if ((options.promptTransport ?? "INLINE_TEXT") === "FILE_ATTACHMENT") {
          if (typeof options.promptFile !== "string" || options.promptFile.trim().length === 0) {
            return printJson({ ok: false, status: "FILE_ATTACHMENT_PROMPT_FILE_REQUIRED", next_action: "rerun with --prompt-file pointing at .txt, .md, or .markdown" });
          }
          return printJson(await sendPromptFileAttachment({ ...options, promptArtifactFilePath: options.promptFile, confirmSend: options.confirmSend === true }));
        }
        return printJson(await sendPrompt({ ...options, prompt: await readPrompt(options), confirmSend: options.confirmSend === true }));
      case "chatgpt-send-smoke":
      case "send-smoke":
        return printJson(await sendSmoke({ ...options, confirmSend: options.confirmSend === true }));
      case "chatgpt-capture":
      case "capture":
        return printJson(await captureMessages(options));
      case "chatgpt-select":
      case "select":
        return printJson(await selectCleanChatGptRootTarget(options));
      case "help":
      case "--help":
      case "-h":
        return printJson(help());
      default:
        process.exitCode = 2;
        return printJson({ ok: false, status: "UNKNOWN_COMMAND", command, usage: help() });
    }
  } catch (error) {
    process.exitCode = 1;
    return printJson({ ok: false, status: "CHATGPT_BROWSER_SESSION_CLI_FAILED", error: error instanceof Error ? error.message : String(error) });
  }
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      if (index >= args.length) throw new Error(`Missing value for ${arg}`);
      return args[index];
    };
    if (arg === "--confirm-send" || arg === "-ConfirmSend") options.confirmSend = true;
    else if (arg === "--confirm-submit" || arg === "-ConfirmSubmit") options.confirmSubmit = true;
    else if (arg === "--confirm-cleanup" || arg === "-ConfirmCleanup") options.confirmCleanup = true;
    else if (arg === "--confirm-repair" || arg === "-ConfirmRepair") options.confirmRepair = true;
    else if (arg === "--dry-run" || arg === "-DryRun") options.dryRun = true;
    else if (arg === "--allow-overwrite" || arg === "-AllowOverwrite") options.allowOverwrite = true;
    else if (arg === "--allow-guest-root-session" || arg === "-AllowGuestRootSession") options.allowGuestRootSession = true;
    else if (arg === "--stdin" || arg === "-Stdin") options.stdin = true;
    else if (arg === "--prompt" || arg === "-Prompt") options.prompt = next();
    else if (arg.startsWith("--prompt=")) options.prompt = arg.slice("--prompt=".length);
    else if (arg === "--prompt-file" || arg === "-PromptFile") options.promptFile = next();
    else if (arg.startsWith("--prompt-file=")) options.promptFile = arg.slice("--prompt-file=".length);
    else if (arg === "--prompt-transport" || arg === "-PromptTransport") options.promptTransport = parsePromptTransport(next());
    else if (arg.startsWith("--prompt-transport=")) options.promptTransport = parsePromptTransport(arg.slice("--prompt-transport=".length));
    else if (arg.startsWith("-PromptTransport=")) options.promptTransport = parsePromptTransport(arg.slice("-PromptTransport=".length));
    else if (arg === "--target-id" || arg === "-TargetId") options.targetId = next();
    else if (arg.startsWith("--target-id=")) options.targetId = arg.slice("--target-id=".length);
    else if (arg === "--keep-target-id" || arg === "-KeepTargetId") options.keepTargetId = next();
    else if (arg.startsWith("--keep-target-id=")) options.keepTargetId = arg.slice("--keep-target-id=".length);
    else if (arg === "--chat-id" || arg === "-ChatId") options.chatId = next();
    else if (arg.startsWith("--chat-id=")) options.chatId = arg.slice("--chat-id=".length);
    else if (arg === "--title" || arg === "-Title") options.title = next();
    else if (arg.startsWith("--title=")) options.title = arg.slice("--title=".length);
    else if (arg === "--profile-dir" || arg === "-ProfileDir") options.profileDir = next();
    else if (arg.startsWith("--profile-dir=")) options.profileDir = arg.slice("--profile-dir=".length);
    else if (arg === "--timeout-ms" || arg === "-TimeoutMs") options.timeoutMs = parseInteger(next(), arg);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = parseInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
    else if (arg === "--duration-ms" || arg === "-DurationMs") options.durationMs = parseInteger(next(), arg);
    else if (arg.startsWith("--duration-ms=")) options.durationMs = parseInteger(arg.slice("--duration-ms=".length), "--duration-ms");
    else if (arg === "--max-close" || arg === "-MaxClose") options.maxClose = parseInteger(next(), arg);
    else if (arg.startsWith("--max-close=")) options.maxClose = parseInteger(arg.slice("--max-close=".length), "--max-close");
    else if (arg === "--ports" || arg === "-Ports") options.ports = parsePorts(next());
    else if (arg.startsWith("--ports=")) options.ports = parsePorts(arg.slice("--ports=".length));
    else if (arg.trim().length > 0) throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readPrompt(options: CliOptions): Promise<string> {
  if (typeof options.prompt === "string") return options.prompt;
  if (typeof options.promptFile === "string") return await readFile(options.promptFile, "utf8");
  if (options.stdin === true || !process.stdin.isTTY) return await readStdin();
  throw new Error("Prompt is required. Use --prompt, --prompt-file, or --stdin.");
}

function parsePromptTransport(value: string): "INLINE_TEXT" | "FILE_ATTACHMENT" {
  const normalized = value.trim().toUpperCase().replace(/-/g, "_");
  if (normalized === "INLINE_TEXT") return "INLINE_TEXT";
  if (normalized === "FILE_ATTACHMENT") return "FILE_ATTACHMENT";
  throw new Error(`Unknown prompt transport: ${value}`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parsePorts(value: string): number[] {
  return value.split(",").map((item) => parseInteger(item.trim(), "--ports")).filter((port) => Number.isInteger(port));
}

function parseInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid integer for ${option}: ${value}`);
  return parsed;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(sanitizeForOutput(value), null, 2)}\n`);
}

function help(): Record<string, unknown> {
  return {
    ok: true,
    commands: ["chatgpt-inventory", "chatgpt-preflight", "chatgpt-auth-status", "chatgpt-session-warmth", "chatgpt-session-warmth-repair", "chatgpt-prune-root-targets", "chatgpt-plugin-settings-cleanup-preview", "chatgpt-plugin-settings-cleanup", "chatgpt-draft", "chatgpt-submit", "chatgpt-send", "chatgpt-send-smoke"],
    examples: [
      "node dist/cli/chatgpt-browser-session-cli.js chatgpt-inventory",
      "node dist/cli/chatgpt-browser-session-cli.js chatgpt-plugin-settings-cleanup-preview --max-close 10",
      "node dist/cli/chatgpt-browser-session-cli.js chatgpt-plugin-settings-cleanup --max-close 10 --confirm-cleanup",
      "node dist/cli/chatgpt-browser-session-cli.js chatgpt-send --prompt-file var/run/startup-diagnostic-prompt.txt --prompt-transport FILE_ATTACHMENT --confirm-send",
    ],
  };
}

await main();
