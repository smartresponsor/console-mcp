#!/usr/bin/env node
import assert from 'node:assert/strict';

function extractChatId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const match = /^\/c\/([^/?#]+)/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractSemanticVerdict(review) {
  if (review === null || typeof review !== 'object') return null;
  for (const key of ['verdict', 'review_result', 'status']) {
    const value = review[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function normalizeSemanticVerdict(value) {
  const verdict = value?.trim().toUpperCase();
  return verdict && verdict.length > 0 ? verdict : 'NEED_SEMANTIC_REVIEW';
}

function evaluateImplementationAdmission(input) {
  const currentChatId = extractChatId(input.currentUrl);
  const semanticVerdict = normalizeSemanticVerdict(input.semanticVerdict ?? extractSemanticVerdict(input.semanticReview));
  const deterministicVerdict = input.deterministicVerdict ?? 'GREEN';
  const deterministicFindingCount = input.deterministicFindingCount ?? 0;
  const blockedReasons = [];

  if (currentChatId === null) blockedReasons.push('NEED_CHAT_ID');
  if (input.expectedChatId && currentChatId !== input.expectedChatId) blockedReasons.push('CHAT_ID_MISMATCH');
  if (input.expectedAssistantHash && input.currentLatestAssistantHash !== input.expectedAssistantHash) blockedReasons.push('STALE_ASSISTANT_HASH');
  if (!input.approvalDetected) blockedReasons.push('NEED_APPROVAL');
  if (deterministicVerdict !== 'GREEN') blockedReasons.push('DETERMINISTIC_REVIEW_NOT_GREEN');
  if (deterministicFindingCount > 0) blockedReasons.push('DETERMINISTIC_FINDINGS_PRESENT');
  if (semanticVerdict !== 'GREEN') blockedReasons.push('SEMANTIC_REVIEW_NOT_GREEN');
  if (input.repoClean === false) blockedReasons.push('REPO_NOT_CLEAN');

  const allowImplementation = blockedReasons.length === 0;
  return {
    ok: allowImplementation,
    status: allowImplementation ? 'IMPLEMENTATION_ALLOWED' : 'IMPLEMENTATION_BLOCKED',
    allow_implementation: allowImplementation,
    blocked_reasons: blockedReasons,
    chat_id: currentChatId,
    deterministic_verdict: deterministicVerdict,
    deterministic_finding_count: deterministicFindingCount,
    semantic_verdict: semanticVerdict,
    approval_detected: input.approvalDetected,
    repo_clean: input.repoClean ?? null,
    required_next_checks: allowImplementation ? ['implementation_diff', 'typecheck', 'build_or_test', 'signed_commit'] : ['resolve_blocked_reasons'],
  };
}

const chatId = '6a44512a-11f0-83ea-9368-9b009d1a76c4';
const url = `https://chatgpt.com/c/${chatId}`;
const hash = 'abc123';

const green = evaluateImplementationAdmission({
  currentUrl: url,
  expectedChatId: chatId,
  expectedAssistantHash: hash,
  currentLatestAssistantHash: hash,
  deterministicVerdict: 'GREEN',
  deterministicFindingCount: 0,
  semanticReview: { review_result: 'GREEN' },
  approvalDetected: true,
  repoClean: true,
});
assert.equal(green.status, 'IMPLEMENTATION_ALLOWED');
assert.equal(green.allow_implementation, true);
assert.deepEqual(green.blocked_reasons, []);
assert.deepEqual(green.required_next_checks, ['implementation_diff', 'typecheck', 'build_or_test', 'signed_commit']);

const blocked = evaluateImplementationAdmission({
  currentUrl: url,
  expectedChatId: chatId,
  expectedAssistantHash: hash,
  currentLatestAssistantHash: 'changed456',
  deterministicVerdict: 'GREEN',
  deterministicFindingCount: 0,
  semanticVerdict: 'AMBER',
  approvalDetected: false,
  repoClean: false,
});
assert.equal(blocked.status, 'IMPLEMENTATION_BLOCKED');
assert.equal(blocked.allow_implementation, false);
assert.deepEqual(blocked.blocked_reasons, ['STALE_ASSISTANT_HASH', 'NEED_APPROVAL', 'SEMANTIC_REVIEW_NOT_GREEN', 'REPO_NOT_CLEAN']);
assert.deepEqual(blocked.required_next_checks, ['resolve_blocked_reasons']);
