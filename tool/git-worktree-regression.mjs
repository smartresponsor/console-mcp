import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createGitWorktree, removeGitWorktree } from "../dist/tool/git-worktree.js";

test("guarded worktree creation preserves source branch and dirty files", async () => {
 const fixture=await mkdtemp(path.join(tmpdir(),"console-worktree-"));
 const source=path.join(fixture,"repository");
 const policy={workspaceRoot:path.join(fixture,"workspace-root"),allowedRoots:[fixture]};
 const git=(args)=>execFileSync("git",args,{cwd:source,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 try{
  await mkdir(source);
  git(["init","-b","master"]);
  git(["config","user.name","Fixture"]);
  git(["config","user.email","fixture@example.test"]);
  await writeFile(path.join(source,"tracked.txt"),"tracked\n");
  git(["add","tracked.txt"]);git(["commit","-m","fixture"]);
  const sha=git(["rev-parse","HEAD"]);
  await writeFile(path.join(source,"untracked.txt"),"preserve\n");
  const input={workspacePath:source,worktreePath:".worktrees/isolation-test",branchName:"feature/isolation-test",startPoint:"HEAD"};
  const preview=await createGitWorktree(policy,{...input,confirmCreate:false});
  assert.equal(preview.status,"CONFIRM_GIT_WORKTREE_CREATE_REQUIRED");
  const output=await createGitWorktree(policy,{...input,confirmCreate:true});
  assert.equal(output.ok,true,JSON.stringify(output));
  assert.equal(output.actualHead,sha);
  assert.equal(git(["branch","--show-current"]),"master");
  assert.equal(git(["rev-parse","HEAD"]),sha);
  assert.match(git(["status","--porcelain=v1"]),/untracked\.txt/);
  const destination=path.join(fixture,".worktrees","isolation-test");
  await writeFile(path.join(destination,"temporary.txt"),"untracked");
  const refused=await removeGitWorktree(policy,{workspacePath:source,worktreePath:".worktrees/isolation-test",confirmRemove:true});
  assert.equal(refused.status,"GIT_WORKTREE_DIRTY");
  await rm(path.join(destination,"temporary.txt"));
  const plan=await removeGitWorktree(policy,{workspacePath:source,worktreePath:".worktrees/isolation-test",confirmRemove:false});
  assert.equal(plan.status,"CONFIRM_GIT_WORKTREE_REMOVE_REQUIRED");
  const removed=await removeGitWorktree(policy,{workspacePath:source,worktreePath:".worktrees/isolation-test",confirmRemove:true});
  assert.equal(removed.status,"GIT_WORKTREE_REMOVED");
  assert.equal(git(["branch","--show-current"]),"master");
  assert.match(git(["branch","--list","feature/isolation-test"]),/feature\/isolation-test/);
 }finally{await rm(fixture,{recursive:true,force:true});}
});
