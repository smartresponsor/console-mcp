import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {registerGitInspectionTools} from "../dist/tool/git-inspection.js";
const temp=await mkdtemp(path.join(tmpdir(),"git-operation-linked-"));
const repo=path.join(temp,"repo"), linked=path.join(temp,"linked");
const git=(cwd,...args)=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
try {
 await mkdir(repo);
 git(repo,"init","-b","fix/fixture");
 git(repo,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","commit","--allow-empty","-m","base");
 git(repo,"worktree","add","-b","fix/linked",linked);
 const gitDir=git(linked,"rev-parse","--absolute-git-dir");
 assert.notEqual(gitDir,path.join(linked,".git"));
 const marker=git(linked,"rev-parse","--git-path","rebase-merge");
 await mkdir(marker);
 const handlers=new Map();
 const policy={workspaceRoot:temp,allowedRoots:[temp]};
 registerGitInspectionTools({registerTool:(name,_config,handler)=>handlers.set(name,handler)},policy,{});
 const result=await handlers.get("write.repo.git.rebase")({workspacePath:linked,action:"continue",upstream:"origin/master",confirmRebase:false});
 const parsed=JSON.parse(result.content[0].text);
 assert.equal(parsed.status,"CONFIRM_GIT_REBASE_REQUIRED",JSON.stringify(parsed));
 assert.equal(parsed.action,"continue");
 const realGit=execFileSync("which",["git"],{encoding:"utf8"}).trim();
 const previousPath=process.env.PATH;
 const previousConfigured=process.env.CONSOLE_MCP_GIT_EXECUTABLE;
 const previousFallback=process.env.GIT_EXECUTABLE;
 try {
  process.env.PATH="";
  for (const key of ["CONSOLE_MCP_GIT_EXECUTABLE","GIT_EXECUTABLE"]) {
   delete process.env.CONSOLE_MCP_GIT_EXECUTABLE;
   delete process.env.GIT_EXECUTABLE;
   process.env[key]=realGit;
   const active=JSON.parse((await handlers.get("write.repo.git.rebase")({workspacePath:linked,action:"start",upstream:"origin/master",confirmRebase:false})).content[0].text);
   assert.equal(active.status,"GIT_REBASE_GUARD_BLOCKED",JSON.stringify(active));
   assert.ok(active.blocks.includes("rebase_already_in_progress"),"Configured Git executable detects linked rebase marker");
   await rm(marker,{recursive:true,force:true});
   const idle=JSON.parse((await handlers.get("write.repo.git.rebase")({workspacePath:linked,action:"start",upstream:"origin/master",confirmRebase:false})).content[0].text);
   assert.equal(idle.status,"CONFIRM_GIT_REBASE_REQUIRED",JSON.stringify(idle));
   await mkdir(marker);
  }
 } finally {
  if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
  if(previousConfigured===undefined)delete process.env.CONSOLE_MCP_GIT_EXECUTABLE;else process.env.CONSOLE_MCP_GIT_EXECUTABLE=previousConfigured;
  if(previousFallback===undefined)delete process.env.GIT_EXECUTABLE;else process.env.GIT_EXECUTABLE=previousFallback;
 }
 console.log(JSON.stringify({status:"LINKED_WORKTREE_REBASE_GUARD_GREEN",markerResolved:true,guardDetected:true,configuredGitOverride:true,emptyPathCovered:true,mutationPerformed:false}));
} finally {await rm(temp,{recursive:true,force:true});}
