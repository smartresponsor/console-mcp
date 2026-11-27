#!/usr/bin/env bash
set -euo pipefail
# Owner-native local signed checkpoints only. No push, merge or deployment.
test "$(id -u)" = 1000
test "${1:-}" = --sign-paired-candidates
console="/home/alex/smartresponse/mcp/.worktrees/console-chat-prompt-screenshot-20261126"
browsing="/home/alex/smartresponse/mcp/looping/.worktrees/browsing-shared-lease-20261127"
key="$HOME/.ssh/id_ed25519_git_signing"
test -f "$key" && test -r "$key"
console_files=(
  src/engine/chat-prompt-screenshot-target.ts
  tool/chat-prompt-screenshot-target-regression.mjs
  src/service/visible-browser-process-lock.ts
  src/service/visible-browser-tools.ts
  tool/chat-prompt-screenshot-admission-regression.mjs
  tool/visible-browser-process-lock-regression.mjs
  package.json
  src/tool/web-domain-bridge.ts
  tool/chat-prompt-screenshot-worker-delegation-regression.mjs
  tool/chat-prompt-screenshot-worker-delegation-regression.ps1
  ops/ubuntu/config/console-mcp-browser-leases.tmpfiles.conf
  ops/ubuntu/config/browser-shared-lease.conf.example
  docs/chat-prompt-screenshot-admission.md
  src/service/direct-browser-operation-lease.ts
  src/engine/engine-cycle-browser.ts
  src/cli/chatgpt-browser-session-cli.ts
  src/service/engine-browser-target-reaper.ts
  src/service/engine-conversation-lifecycle.ts
  src/service/chatgpt-background-target-cleaner.ts
  ops/ubuntu/script/watchdog.sh
  ops/ubuntu/script/runtime-maintenance.sh
  ops/ubuntu/script/engine-cli.sh
  tool/ubuntu-observer-safety-regression.mjs
  tool/chat-prompt-screenshot-final-integration-regression.ps1
  tool/chat-prompt-screenshot-paired-checkpoint.sh
)
browsing_files=(playwright-worker/src/worker.js)
check() {
  local repo="$1" head="$2" branch="$3"; shift 3
  test "$(git -C "$repo" rev-parse HEAD)" = "$head"
  test "$(git -C "$repo" branch --show-current)" = "$branch"
  git -C "$repo" diff --cached --quiet
  git -C "$repo" diff --check
  diff <(printf '%s\n' "$@" | LC_ALL=C sort -u) <({ git -C "$repo" diff --name-only HEAD; git -C "$repo" ls-files --others --exclude-standard; } | LC_ALL=C sort -u)
}
check "$console" 1a05e0313ef396b1dac8394970f0d8dfff2a9620 feature/chat-prompt-screenshot "${console_files[@]}"
check "$browsing" 059251d2f938bdb864c53a43027327c0c1a4a104 feature/shared-browser-lease "${browsing_files[@]}"
sign() {
  local repo="$1" message="$2"; shift 2
  git -C "$repo" add -- "$@"
  git -C "$repo" diff --cached --check
  git -C "$repo" diff --cached --stat
  git -C "$repo" -c user.signingkey="$key" -c gpg.format=ssh -c commit.gpgsign=true commit -S -m "$message"
  git -C "$repo" log -1 --format='%H %P %s'
  git -C "$repo" verify-commit HEAD
  test -z "$(git -C "$repo" status --porcelain)"
}
sign "$console" "fix(engine): coordinate shared screenshot browser lease" "${console_files[@]}"
sign "$browsing" "fix(worker): hold shared browser lease through execution" "${browsing_files[@]}"
echo SCREENSHOT_PAIRED_SIGNED_CHECKPOINT_PASS
