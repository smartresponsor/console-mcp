import assert from "node:assert/strict";
import { sanitizeForOutput } from "../../dist/service/browser-session-executor.js";

const sharedDiagnostic = { status: "SAFE_STATUS", ok: true, count: 1 };
const realCycle = { status: "CYCLIC" };
realCycle.self = realCycle;

const leaked = {
  accessToken: "accessToken-secret",
  sessionToken: "sessionToken-secret",
  bootstrap: "<script>client-bootstrap accessToken-secret</script>",
  singleItemArray: [{ status: "ARRAY_ITEM", ok: true }],
  signals: [{ status: "SIGNAL_READY" }],
  matches: null,
  selected_target_candidates: [{ id: "candidate-1", type: "page", title: "Candidate", url: "https://chatgpt.com/", chat_id: null, has_web_socket_debugger_url: true }],
  candidate_rejections: [{ target_id: "candidate-2", reason: "COMPOSER_NOT_EMPTY" }],
  repeatedA: sharedDiagnostic,
  repeatedB: sharedDiagnostic,
  realCycle,
  attachment: {
    cleanup: {
      status: "FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_DONE",
      before_prompt_file_count: 2,
      after_prompt_file_count: 0,
      removed_prompt_file_count: 2,
      cleanup_clicked_count: 2,
      stale_prompt_file_names: [
        "prompt-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt",
      ],
      current_file_name: "prompt-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.md",
      retryable: false,
      next_action: "continue attach",
    },
  },
  debuggerUrls: {
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/standalone",
    devtoolsFrontendUrl: "devtools://devtools/bundled/inspector.html",
  },
  target: {
    port: 9223,
    id: "target-1",
    type: "page",
    title: "ChatGPT",
    url: "https://chatgpt.com/c/chat-1",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target-1",
    devtoolsFrontendUrl: "devtools://devtools/bundled/inspector.html",
    extra: "must be compacted away",
  },
  scriptNode: {
    nodeName: "SCRIPT",
    nodeValue: "client-bootstrap sessionToken-secret",
  },
};

const sanitized = sanitizeForOutput(leaked);
const text = JSON.stringify(sanitized);

assert.equal(text.includes("accessToken-secret"), false);
assert.equal(text.includes("sessionToken-secret"), false);
assert.equal(text.includes("client-bootstrap"), false);
assert.equal(text.includes("ws://127.0.0.1/devtools"), false);
assert.equal(text.includes("devtools://devtools"), false);
assert.equal(Array.isArray(sanitized.singleItemArray), true);
assert.equal(sanitized.singleItemArray.length, 1);
assert.equal(Array.isArray(sanitized.signals), true);
assert.equal(sanitized.signals.length, 1);
assert.equal(sanitized.matches, null);
assert.equal(Array.isArray(sanitized.selected_target_candidates), true);
assert.equal(sanitized.selected_target_candidates[0].has_web_socket_debugger_url, true);
assert.equal(Array.isArray(sanitized.candidate_rejections), true);
assert.notEqual(sanitized.repeatedA, "[circular]");
assert.notEqual(sanitized.repeatedB, "[circular]");
assert.deepEqual(sanitized.repeatedA, sanitized.repeatedB);
assert.equal(sanitized.realCycle.self, "[circular]");
assert.deepEqual(Object.keys(sanitized.attachment.cleanup).sort(), [
  "after_prompt_file_count",
  "before_prompt_file_count",
  "cleanup_clicked_count",
  "current_file_name",
  "next_action",
  "removed_prompt_file_count",
  "retryable",
  "stale_prompt_file_names",
  "status",
].sort());
assert.equal(sanitized.debuggerUrls.webSocketDebuggerUrl, "[redacted]");
assert.equal(sanitized.debuggerUrls.devtoolsFrontendUrl, "[redacted]");
assert.equal(sanitized.target.has_web_socket_debugger_url, true);
assert.equal(typeof sanitized.target.has_web_socket_debugger_url, "boolean");
assert.deepEqual(Object.keys(sanitized.target).sort(), [
  "chat_id",
  "has_web_socket_debugger_url",
  "id",
  "port",
  "title",
  "type",
  "url",
].sort());

console.log(JSON.stringify({ ok: true, status: "CHATGPT_OUTPUT_SANITIZER_SMOKE_READY" }));
