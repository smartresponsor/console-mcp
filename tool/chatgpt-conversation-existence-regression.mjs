import assert from "node:assert/strict";
import { classifyChatGptConversationExistence } from "../dist/service/chatgpt-conversation-existence.js";

const classify = (httpStatus, bodyPreview = null, error = null) => classifyChatGptConversationExistence({ chatId: "chat-1", httpStatus, bodyPreview, error });

assert.equal(classify(200).status, "LIVE");
assert.equal(classify(404, '{"detail":"conversation_deleted"}').status, "DELETED_CONFIRMED");
assert.equal(classify(404, '{"detail":"not_found"}').status, "NOT_FOUND_UNCLASSIFIED");
assert.equal(classify(401).status, "AUTH_BLOCKED");
assert.equal(classify(403).status, "AUTH_BLOCKED");
assert.equal(classify(429).status, "RATE_LIMITED");
assert.equal(classify(503).status, "SERVER_ERROR");
assert.equal(classify(null, null, "fetch failed").status, "NETWORK_ERROR");
assert.equal(classify(0).status, "PROBE_INCONCLUSIVE");

console.log(JSON.stringify({ ok: true, status: "CHATGPT_CONVERSATION_EXISTENCE_REGRESSION_GREEN" }));
