import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConsolePolicy } from "./policy.js";
import { assertAllowedRoot } from "./path.js";

export type ChatGptComponentLabelResolution = {
  ok: boolean;
  status: string;
  workspace_path: string;
  composer_path: string;
  composer_name: string | null;
  component_token: string | null;
  package_token: string | null;
  workspace_folder: string;
  folder_matches_component: boolean | null;
  chat_id: string | null;
  chat_stamp: string | null;
  title_prefix: string | null;
  reasons: string[];
};

export type ChatGptComponentChatRegistryRecord = {
  provider: "chatgpt-web";
  chat_id: string;
  component_token: string;
  package_token: string;
  composer_name: string;
  workspace_path: string;
  workspace_folder: string;
  chat_stamp: string;
  title_prefix: string;
  desired_title: string | null;
  rename_status: string | null;
  updated_at: string;
};

type ChatGptComponentChatRegistry = {
  schema: "console-mcp.chatgpt-component-chat-registry.v1";
  updated_at: string;
  chats: Record<string, ChatGptComponentChatRegistryRecord>;
};

const COMPOSER_NAME_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,119}$/;
const CHAT_STAMP_PATTERN = /^[A-Za-z0-9_-]{6,16}$/;

export async function resolveChatGptComponentLabel(policy: ConsolePolicy, workspacePath: string, chatId?: string | null): Promise<ChatGptComponentLabelResolution> {
  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const composerPath = path.join(workspace, "composer.json");
  const workspaceFolder = path.basename(workspace).toLowerCase();
  const reasons: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(composerPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      status: "COMPOSER_JSON_NOT_READABLE",
      workspace_path: workspace,
      composer_path: composerPath,
      composer_name: null,
      component_token: null,
      package_token: null,
      workspace_folder: workspaceFolder,
      folder_matches_component: null,
      chat_id: chatId ?? null,
      chat_stamp: null,
      title_prefix: null,
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }

  const composerName = typeof (parsed as { name?: unknown }).name === "string" ? (parsed as { name: string }).name.trim().toLowerCase() : null;
  if (!composerName) {
    reasons.push("composer_name_missing");
  } else if (!COMPOSER_NAME_PATTERN.test(composerName)) {
    reasons.push("composer_name_must_have_two_tokens");
  }

  const [componentToken = null, packageToken = null] = composerName?.split("/", 2) ?? [];
  if (componentToken !== null && !TOKEN_PATTERN.test(componentToken)) {
    reasons.push("component_token_invalid");
  }
  if (packageToken !== null && !TOKEN_PATTERN.test(packageToken)) {
    reasons.push("package_token_invalid");
  }

  const folderMatches = componentToken !== null ? workspaceFolder === componentToken : null;
  if (folderMatches === false) {
    reasons.push("workspace_folder_component_mismatch");
  }

  const chatStamp = chatId ? buildShortChatStamp(chatId) : null;
  if (chatId && chatStamp === null) {
    reasons.push("chat_id_stamp_unusable");
  }

  const ok = reasons.length === 0;
  return {
    ok,
    status: ok ? "CHAT_COMPONENT_LABEL_READY" : "CHAT_COMPONENT_LABEL_BLOCKED",
    workspace_path: workspace,
    composer_path: composerPath,
    composer_name: composerName,
    component_token: componentToken,
    package_token: packageToken,
    workspace_folder: workspaceFolder,
    folder_matches_component: folderMatches,
    chat_id: chatId ?? null,
    chat_stamp: chatStamp,
    title_prefix: ok && componentToken && chatStamp ? buildChatGptTitlePrefix(componentToken, chatStamp) : null,
    reasons,
  };
}

export function buildShortChatStamp(chatId: string): string | null {
  const compact = chatId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 10);
  return CHAT_STAMP_PATTERN.test(compact) ? compact : null;
}

export function buildChatGptTitlePrefix(componentToken: string, chatStamp: string): string {
  return `[${componentToken}:${chatStamp}]`;
}

export function buildPrefixedChatTitle(titlePrefix: string, currentTitle?: string | null): string {
  const cleanedCurrent = String(currentTitle ?? "").replace(/\s+/g, " ").trim();
  const currentWithoutOldPrefix = cleanedCurrent.replace(/^\[[a-z0-9][a-z0-9_.-]{0,119}:[A-Za-z0-9_-]{6,16}\]\s*/u, "").trim();
  const suffix = currentWithoutOldPrefix.length > 0 ? currentWithoutOldPrefix : "New chat";
  return `${titlePrefix} ${suffix}`.slice(0, 120);
}

export async function recordChatGptComponentChatToken(policy: ConsolePolicy, record: Omit<ChatGptComponentChatRegistryRecord, "provider" | "updated_at">): Promise<{ ok: boolean; status: string; path: string; chat_id: string }> {
  const registryPath = path.join(policy.transcriptDir, "chatgpt-component-chat-registry.json");
  await mkdir(path.dirname(registryPath), { recursive: true });
  const now = new Date().toISOString();
  const registry = await readRegistry(registryPath);
  registry.updated_at = now;
  registry.chats[record.chat_id] = {
    provider: "chatgpt-web",
    ...record,
    updated_at: now,
  };
  await writeJsonAtomic(registryPath, registry);
  return { ok: true, status: "CHAT_COMPONENT_TOKEN_RECORDED", path: registryPath, chat_id: record.chat_id };
}

async function readRegistry(filePath: string): Promise<ChatGptComponentChatRegistry> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<ChatGptComponentChatRegistry>;
    if (parsed.schema === "console-mcp.chatgpt-component-chat-registry.v1" && parsed.chats && typeof parsed.chats === "object") {
      return { schema: parsed.schema, updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date(0).toISOString(), chats: parsed.chats as Record<string, ChatGptComponentChatRegistryRecord> };
    }
  } catch {
    return { schema: "console-mcp.chatgpt-component-chat-registry.v1", updated_at: new Date(0).toISOString(), chats: {} };
  }

  return { schema: "console-mcp.chatgpt-component-chat-registry.v1", updated_at: new Date(0).toISOString(), chats: {} };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}
