import assert from "node:assert/strict";

import {
  buildChatGptArtifactCorrectionComment,
  buildChatGptSemanticReviewRequest,
  createChatGptArtifactCursor,
  createChatGptSessionBinding,
  extractChatGptChatId,
  findChatGptDeterministicCanonRisks,
  hashChatGptArtifactText,
  isChatGptExecutionApproval,
  markAssistantArtifactGuarded,
  selectNextAssistantArtifact,
  verifyChatGptInjectionTarget,
} from "../dist/service/chatgpt-artifact-guard.js";

const chatId = "abc123_chat-guard";
const url = `https://chatgpt.com/c/${chatId}`;

assert.equal(extractChatGptChatId(url), chatId);
assert.equal(extractChatGptChatId(`https://chatgpt.com/chat/${chatId}`), chatId);
assert.equal(extractChatGptChatId(`https://chatgpt.com/?chatId=${chatId}`), chatId);
assert.equal(extractChatGptChatId("not a url"), null);
assert.equal(extractChatGptChatId("https://chatgpt.com/"), null);

const historicalAssistant = "Historical assistant response before binding.";
const binding = createChatGptSessionBinding({
  url,
  boundAt: "2026-06-30T00:00:00.000Z",
  baselineAssistantText: historicalAssistant,
});

assert.equal(binding.chatId, chatId);
assert.equal(binding.provider, "chatgpt-web");
assert.equal(binding.mode, "default_webui");
assert.equal(binding.baselineAssistantHash, hashChatGptArtifactText(historicalAssistant));
assert.equal(binding.lastGuardedAssistantHash, binding.baselineAssistantHash);

let cursor = createChatGptArtifactCursor(binding);

const onlyUserMessages = [
  { role: "assistant", text: historicalAssistant },
  { role: "user", text: "Initial user prompt. Guard must skip it." },
  { role: "user", text: "Second user prompt after a transient failure. Guard must still wait." },
];

assert.equal(selectNextAssistantArtifact(onlyUserMessages, cursor), null);

const firstGuardableAssistant = "First assistant artifact after the user prompts.";
const withAssistant = [
  ...onlyUserMessages,
  { role: "assistant", text: firstGuardableAssistant },
];

const firstArtifact = selectNextAssistantArtifact(withAssistant, cursor);
assert.ok(firstArtifact);
assert.equal(firstArtifact.role, "assistant");
assert.equal(firstArtifact.text, firstGuardableAssistant);
assert.equal(firstArtifact.index, 3);

cursor = markAssistantArtifactGuarded(cursor, firstArtifact);
assert.equal(selectNextAssistantArtifact(withAssistant, cursor), null);

const secondGuardableAssistant = "Second assistant artifact after guard reply.";
const withSecondAssistant = [
  ...withAssistant,
  { role: "user", text: "Go. Execute approved plan only." },
  { role: "assistant", text: secondGuardableAssistant },
];

const secondArtifact = selectNextAssistantArtifact(withSecondAssistant, cursor);
assert.ok(secondArtifact);
assert.equal(secondArtifact.text, secondGuardableAssistant);
assert.equal(secondArtifact.index, 5);

const safeInjection = verifyChatGptInjectionTarget({
  binding,
  currentUrl: url,
  expectedAssistantHash: firstArtifact.hash,
  currentLatestAssistantText: firstGuardableAssistant,
  promptAvailable: true,
});

assert.equal(safeInjection.ok, true);
assert.deepEqual(safeInjection.reasons, []);

const wrongChatInjection = verifyChatGptInjectionTarget({
  binding,
  currentUrl: "https://chatgpt.com/c/wrong-chat-id",
  expectedAssistantHash: firstArtifact.hash,
  currentLatestAssistantText: firstGuardableAssistant,
  promptAvailable: true,
});

assert.equal(wrongChatInjection.ok, false);
assert.ok(wrongChatInjection.reasons.includes("chat_id_mismatch"));

const staleArtifactInjection = verifyChatGptInjectionTarget({
  binding,
  currentUrl: url,
  expectedAssistantHash: firstArtifact.hash,
  currentLatestAssistantText: secondGuardableAssistant,
  promptAvailable: true,
});

assert.equal(staleArtifactInjection.ok, false);

assert.equal(isChatGptExecutionApproval("Next"), true);
assert.equal(isChatGptExecutionApproval("делай"), true);
assert.equal(isChatGptExecutionApproval("please review"), false);

const findings = findChatGptDeterministicCanonRisks("Create a runtime/standalone directory and CRUD controller.");
assert.equal(findings.length, 2);
assert.match(buildChatGptArtifactCorrectionComment(findings), /Do not execute yet/);

const semanticReview = buildChatGptSemanticReviewRequest({
  artifactText: "Create src/Domain classes and CRUD controllers.",
  chatId,
  deterministicFindings: findings,
  canonizingWorkspacePath: "D:\\PhpstormProjects\\www\\.gating",
});
assert.equal(semanticReview.kind, "review_only_semantic_guard");
assert.equal(semanticReview.promptVersion, "chatgpt-semantic-guard.v1");
assert.equal(semanticReview.context.chatId, chatId);
assert.equal(semanticReview.context.deterministicFindings.length, findings.length);
assert.ok(semanticReview.prompt.includes("Review-only semantic guard"));
assert.ok(semanticReview.prompt.includes("JSON"));
assert.equal(semanticReview.outputSchema.verdict, "GREEN|AMBER|RED|STALE|NEED_BINDING|OPS_REQUIRED");
