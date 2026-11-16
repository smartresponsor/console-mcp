#!/usr/bin/env bash
set -Eeuo pipefail
REPO=https://github.com/smartresponsor/console-mcp.git
BRANCH=security/dependabot-hono-node-server-20261116
TARGET="$HOME/smartresponse-security-candidates/console-mcp-hono-20261116"
mkdir -p "$(dirname "$TARGET")"
if [[ -e "$TARGET" ]]; then echo "REFUSE: target exists: $TARGET" >&2; exit 2; fi
git clone --branch "$BRANCH" --single-branch "$REPO" "$TARGET"
cd "$TARGET"
test -z "$(git status --porcelain)"
printf 'BASE_SHA=%s\n' "$(git rev-parse HEAD)"
npm ci --ignore-scripts
test -x node_modules/.bin/tsc
set +e
npm run typecheck > /tmp/console-security-baseline-typecheck.log 2>&1; BT=$?
npm run build > /tmp/console-security-baseline-build.log 2>&1; BB=$?
npm audit --omit=dev --json > /tmp/console-security-baseline-audit.json 2>&1; BA=$?
set -e
printf 'BASELINE typecheck=%s build=%s audit=%s\n' "$BT" "$BB" "$BA"
npm update hono @hono/node-server --package-lock-only --ignore-scripts
npm ci --ignore-scripts
node - <<'NODE'
const p=require('./package-lock.json').packages;
for (const [name,min] of [['hono',[4,13,16]],['@hono/node-server',[2,1,6]]]) {
 const version=p['node_modules/'+name]?.version;
 if (!version) throw Error('Missing '+name);
 const a=version.split('.').map(Number);
 if (a[0]<min[0] || (a[0]===min[0] && (a[1]<min[1] || (a[1]===min[1] && a[2]<min[2])))) throw Error('Vulnerable '+name+' '+version);
 console.log('PATCHED',name,version);
}
NODE
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=moderate
set +e
npm test > /tmp/console-security-candidate-test.log 2>&1; TEST=$?
set -e
printf 'CANDIDATE_TEST_EXIT=%s\n' "$TEST"
git diff --check
git status --short
printf 'CANDIDATE=%s (NOT committed, NOT deployed)\n' "$TARGET"
if (( TEST != 0 )); then echo 'TEST FAILED: /tmp/console-security-candidate-test.log' >&2; exit 5; fi
