import { readFile } from "node:fs/promises";
import {
  captureMessages,
  inspectAuthStatus,
  inspectSessionWarmth,
  draftInput,
  inspectComposerPreflight,
  inventoryChatGptTargets,
  selectCleanChatGptRootTarget,
  sendPrompt,
  sendSmoke,
  submitDraft,
} from "../service/browser-session-executor.js";

type CliOptions = {
  ports?: number[];
  timeoutMs?: number;
  targetId?: string;
  chatId?: string;
  allowOverwrite?: boolean;
  allowGuestRootSession?: boolean;
  profileDir?: string;
  confirmSend?: boolean;
  confirmSubmit?: boolean;
  prompt?: string;
  promptFile?: string;
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
      case "chatgpt-draft":
      case "draft":
        return printJson(await draftInput({ ...options, prompt: await readPrompt(options) }));
      case "chatgpt-submit":
      case "submit":
        return printJson(await submitDraft({ ...options, confirmSubmit: options.confirmSubmit === true }));
      case "chatgpt-send":
      case "send":
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
    else if (arg === "--allow-overwrite" || arg === "-AllowOverwrite") options.allowOverwrite = true;
    else if (arg === "--allow-guest-root-session" || arg === "-AllowGuestRootSession") options.allowGuestRootSession = true;
    else if (arg === "--stdin" || arg === "-Stdin") options.stdin = true;
    else if (arg === "--prompt" || arg === "-Prompt") options.prompt = next();
    else if (arg.startsWith("--prompt=")) options.prompt = arg.slice("--prompt=".length);
    else if (arg === "--prompt-file" || arg === "-PromptFile") options.promptFile = next();
    else if (arg.startsWith("--prompt-file=")) options.promptFile = arg.slice("--prompt-file=".length);
    else if (arg === "--target-id" || arg === "-TargetId") options.targetId = next();
    else if (arg.startsWith("--target-id=")) options.targetId = arg.slice("--target-id=".length);
    else if (arg === "--chat-id" || arg === "-ChatId") options.chatId = next();
    else if (arg.startsWith("--chat-id=")) options.chatId = arg.slice("--chat-id=".length);
    else if (arg === "--profile-dir" || arg === "-ProfileDir") options.profileDir = next();
    else if (arg.startsWith("--profile-dir=")) options.profileDir = arg.slice("--profile-dir=".length);
    else if (arg === "--timeout-ms" || arg === "-TimeoutMs") options.timeoutMs = parseInt(next(), 10);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = parseInt(arg.slice("--timeout-ms=".length), 10);
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
  return value.split(",").map((item) => parseInt(item.trim(), 10)).filter((port) => Number.isInteger(port));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(): Record<string, unknown> {
  return {
    ok: true,
    commands: ["chatgpt-inventory", "chatgpt-preflight", "chatgpt-auth-status", "chatgpt-session-warmth", "chatgpt-draft", "chatgpt-submit", "chatgpt-send", "chatgpt-send-smoke"],
    examples: [
      "node dist/cli/chatgpt-browser-session-cli.js chatgpt-inventory",
      "node dist/cli/chatgpt-browser-session-cli.js chatgpt-send --prompt-file var/run/startup-diagnostic-prompt.txt --confirm-send",
    ],
  };
}

await main();
