import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildGitBranchStatus, registerGitInspectionTools, scopedLinkedWorktreeTrust } from '../dist/tool/git-inspection.js';

const temp = await mkdtemp(path.join('/home/alex/smartresponse', '.git-inspection-regression-'));
const repo = path.join(temp, 'repo');
const originalPath = process.env.PATH;

const policy = { workspaceRoot: temp, allowedRoots: [temp] };
const handlers = new Map();
registerGitInspectionTools({ registerTool: (name, config, fn) => handlers.set(name, fn) }, policy, {});
const call = async (name, args) => JSON.parse((await handlers.get(name)(args)).content[0].text);
try {
  await mkdir(repo);
  let result = await buildGitBranchStatus(policy, repo);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'GIT_STATUS_UNAVAILABLE');
  assert.equal(result.isDirty, null);
  assert.equal(result.dirtyCount, null);
  assert.ok(result.failures.every(f => f.exitCode === 128 && f.stderr.includes('not a git repository')));
  execFileSync('git', ['init', '-b', 'fix/test'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=Regression', '-c', 'user.email=regression@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
  result = await buildGitBranchStatus(policy, repo);
  assert.equal(result.ok, true, 'a valid repository without an upstream is supported');
  assert.equal(result.isDirty, false);
  await writeFile(path.join(repo, 'untracked.txt'), 'fixture\n');
  assert.equal((await buildGitBranchStatus(policy, repo)).isDirty, true);
  // Inject a bounded Git fixture: status fails while branch and HEAD still succeed.
  const bin = path.join(temp, 'bin');
  await mkdir(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await writeFile(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = status ]; then echo 'status inspection denied' >&2; exit 37; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  result = await buildGitBranchStatus(policy, repo);
  assert.equal(result.ok, false);
  assert.equal(result.isDirty, null);
  assert.ok(result.failures.some(f => f.exitCode === 37 && f.stderr.includes('status inspection denied')));
  const sync = await call('read_.repo.git.sync.plan', { workspacePath: repo });
  assert.equal(sync.ok, false);
  assert.equal(sync.status, 'GIT_STATUS_UNAVAILABLE');
  assert.notEqual(sync.nextAction, 'already_synced');
  const push = await call('write.repo.git.push.current.set.upstream', { workspacePath: repo, confirmPush: true });
  assert.equal(push.ok, false);
  assert.ok(push.blocks.includes('git_status_unavailable'));
  await writeFile(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = rev-parse ] && [ "$2" = --abbrev-ref ]; then echo "fatal: upstream branch 'refs/heads/fix/test' not stored as a remote-tracking branch" >&2; exit 128; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  result = await buildGitBranchStatus(policy, repo);
  assert.equal(result.ok, true, 'a missing remote-tracking upstream is treated as no upstream');
  assert.equal(result.upstream, null);
  assert.equal(result.ahead, null);
  assert.equal(result.behind, null);
  await writeFile(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = rev-parse ] && [ "$2" = --abbrev-ref ]; then echo 'upstream inspection failed' >&2; exit 38; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  result = await buildGitBranchStatus(policy, repo);
  assert.equal(result.ok, false, 'unexpected upstream errors must fail closed');
  assert.ok(result.failures.some(f => f.inspection === 'upstream' && f.exitCode === 38));
  await writeFile(path.join(bin, 'git'), "#!/bin/sh\necho 'fatal: detected dubious ownership in repository' >&2\nexit 128\n", { mode: 0o755 });
  result = await buildGitBranchStatus(policy, repo);
  assert.equal(result.status, 'GIT_OWNERSHIP_UNSAFE');
  assert.equal(result.ok, false);
  assert.equal(result.statusPorcelain, null);
  process.env.PATH = '/nonexistent';
  result = await buildGitBranchStatus(policy, repo);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'GIT_STATUS_UNAVAILABLE');
  assert.ok(result.failures.every(f => f.exitCode === null));
  process.env.PATH = originalPath;
  // A legitimate linked worktree receives process-local exact-path trust.
  const linked = path.join(temp, 'linked');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', linked, 'HEAD'], { stdio: 'ignore' });
  const linkedDiff = await call('read_.repo.git.diff', { workspacePath: linked });
  assert.equal(linkedDiff.ok, true, 'valid linked worktree supports read-only Git');
  assert.equal((await buildGitBranchStatus(policy, linked)).ok, true);
  // A copied gitfile cannot borrow another worktree's gitdir trust.
  const forged = path.join(temp, 'forged');
  await mkdir(forged);
  const { readFile } = await import('node:fs/promises');
  await writeFile(path.join(forged, '.git'), await readFile(path.join(linked, '.git')));
  const forgedDiff = await call('read_.repo.git.diff', { workspacePath: forged });
  assert.deepEqual(scopedLinkedWorktreeTrust(forged, policy), [], 'forged linked-worktree metadata must not receive ownership bypass');
  // A symlinked .git marker must never grant a trust override.
  const symlinked = path.join(temp, 'symlinked');
  await mkdir(symlinked);
  const { symlink } = await import('node:fs/promises');
  await symlink(path.join(linked, '.git'), path.join(symlinked, '.git'));
  assert.deepEqual(scopedLinkedWorktreeTrust(symlinked, policy), [], 'symlinked gitfile must not receive ownership bypass');
  // Hardlinked gitfile metadata must never grant process-local ownership bypass.
  const hardlinked = path.join(temp, 'hardlinked');
  await mkdir(hardlinked);
  const { link } = await import('node:fs/promises');
  await link(path.join(linked, '.git'), path.join(hardlinked, '.git'));
  assert.deepEqual(scopedLinkedWorktreeTrust(linked, policy), [], 'hardlinked original marker must lose trust');
  assert.deepEqual(scopedLinkedWorktreeTrust(hardlinked, policy), [], 'hardlinked alias must not gain trust');
  await rm(path.join(hardlinked, '.git'));
  assert.deepEqual(scopedLinkedWorktreeTrust(linked, policy), ['-c', `safe.directory=${linked}`], 'trust restores after hardlink removal');
  // A linked-worktree backlink must itself be a regular, single-link file.
  const gitfile = (await readFile(path.join(linked, '.git'), 'utf8')).trim();
  const gitdir = path.resolve(linked, gitfile.slice('gitdir: '.length));
  const backlink = path.join(gitdir, 'gitdir');
  const backlinkContents = await readFile(backlink);
  const backlinkAlias = path.join(gitdir, 'gitdir-alias');
  await link(backlink, backlinkAlias);
  assert.deepEqual(scopedLinkedWorktreeTrust(linked, policy), [], 'hardlinked backlink must not grant ownership bypass');
  await rm(backlinkAlias);
  await rm(backlink);
  await symlink(backlinkAlias, backlink);
  await writeFile(backlinkAlias, backlinkContents);
  assert.deepEqual(scopedLinkedWorktreeTrust(linked, policy), [], 'symlinked backlink must not grant ownership bypass');
  await rm(backlink);
  await rm(backlinkAlias);
  await writeFile(backlink, backlinkContents);
  assert.deepEqual(scopedLinkedWorktreeTrust(linked, policy), ['-c', `safe.directory=${linked}`], 'regular backlink restores trust');
  execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', linked], { stdio: 'ignore' });
  console.log('git inspection fail-closed regression: PASS (invalid repo, no upstream, clean/dirty, partial failure, unsafe ownership, missing Git, sync/push guards)');
} finally {
  process.env.PATH = originalPath;
  await rm(temp, { recursive: true, force: true });
}
