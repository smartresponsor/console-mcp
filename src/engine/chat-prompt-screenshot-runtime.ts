import { executeChatPromptScreenshot } from "./chat-prompt-screenshot-execution.js";
import { acquireChatPromptScreenshotTarget } from "./chat-prompt-screenshot-target.js";
import { withChatPromptScreenshotLease } from "../service/visible-browser-tools.js";
import { prepareChatPromptScreenshot } from "./chat-prompt-screenshot.js";

// Registered in the candidate; production activation requires live acceptance.
export async function runChatPromptScreenshot(url: string) {
  prepareChatPromptScreenshot(url);
  return withChatPromptScreenshotLease((anchor, verify) =>
    executeChatPromptScreenshot(url, () => acquireChatPromptScreenshotTarget(anchor, verify)));
}
