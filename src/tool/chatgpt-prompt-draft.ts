// This tool was never registered (registerChatGptPromptDraftTool was a no-op stub, not imported
// by src/index.ts) and its DevTools-based composer-typing implementation duplicated the live
// path in src/Consumer/ChatGpt/Draft/ChatGptPromptDraft.ts (which types via CDP Input.insertText
// and is wired into src/service/browser-session-executor.ts). Removed as dead code to avoid a
// third, unused implementation of "type into the ChatGPT composer" sitting in the repo.
//
// Live composer-typing path: src/Consumer/ChatGpt/Draft/ChatGptPromptDraft.ts (draftInput).
export {};
