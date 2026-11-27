import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, lstatSync, openSync, closeSync, fstatSync, readSync, readdirSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { assertOwnerRepositoryMutationRoot } from "./RepositoryMutationContract.js";
import { assertReadablePath } from "../../Policy/PathGuard.js";
import type { ConsolePolicy } from "../../Policy/ConsolePolicy.js";

const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const sig = (s: Stats) => [s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(":");
const maxBytes = 256 * 1024 * 1024;
const maxEntries = 20000;

/** Bounded read observation, never an execution lease or authorization. */
export function observeOwnerGitEvidence(policy: ConsolePolicy, cwd: string, nonce: string) {
  if (!/^[0-9a-f]{64}$/.test(nonce) || !assertOwnerRepositoryMutationRoot(cwd)) throw new Error("OWNER_EVIDENCE_ADMISSION_REQUIRED");
  const env = {PATH:"/usr/bin:/bin", HOME:"/nonexistent", LANG:"C", LC_ALL:"C", GIT_CONFIG_GLOBAL:"/dev/null", GIT_CONFIG_SYSTEM:"/dev/null", GIT_CONFIG_NOSYSTEM:"1", GIT_OPTIONAL_LOCKS:"0"};
  const git = (args: string[]) => execFileSync("/usr/bin/git",["--no-optional-locks","-c","safe.directory=","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false",...args],{cwd,env,timeout:15000,maxBuffer:4*1024*1024});
  const observe = () => {
    const root = lstatSync(cwd);
    const head=git(["rev-parse","--verify","HEAD"]).toString().trim();
    if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error("OWNER_EVIDENCE_HEAD_INVALID");
    if (git(["rev-parse","--show-toplevel"]).toString().trim() !== cwd) throw new Error("OWNER_EVIDENCE_ROOT_MISMATCH");
    const gitdir=git(["rev-parse","--absolute-git-dir"]).toString().trim();
    const index=path.join(gitdir,"index");
    if (realpathSync(gitdir)!==gitdir) throw new Error("OWNER_EVIDENCE_METADATA_PATH");
    let bytes=0,entries=0;
    const digest=createHash("sha256");
    const record=(v:unknown)=>{digest.update(JSON.stringify(v)+"\n");};
    const file = (p:string,s:Stats) => {
      if (!s.isFile() || s.nlink!==1 || s.size>maxBytes-bytes) throw new Error("OWNER_EVIDENCE_FILE_LIMIT_OR_POLICY");
      const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        if (sig(fstatSync(fd))!==sig(s)) throw new Error("OWNER_EVIDENCE_DRIFT");
        const h=createHash("sha256");
        const chunk=Buffer.alloc(Math.min(1024*1024,Math.max(1,s.size)));
        let consumed=0;
        while (consumed<s.size) {
          const n=readSync(fd,chunk,0,Math.min(chunk.length,s.size-consumed),null);
          if (n===0) throw new Error("OWNER_EVIDENCE_DRIFT");
          h.update(chunk.subarray(0,n));consumed+=n;
        }
        if (readSync(fd,chunk,0,1,null)!==0 || sig(fstatSync(fd))!==sig(s)) throw new Error("OWNER_EVIDENCE_DRIFT");
        bytes+=consumed;return h.digest("hex");
      } finally {closeSync(fd);}
    };
    const visit=(p:string,rel:string) => {
      if (++entries>maxEntries) throw new Error("OWNER_EVIDENCE_ENTRY_LIMIT");
      if (rel!==".") assertReadablePath(p,policy.deniedPath,[cwd]);
      const s=lstatSync(p);
      if (s.dev!==root.dev || s.uid!==1000 || s.gid!==1001 || (s.mode&0o022)!==0 || s.isSymbolicLink()) throw new Error("OWNER_EVIDENCE_ENTRY_POLICY");
      if (s.isDirectory()) {
        record([rel,sig(s)]);
        const names=readdirSync(p).sort();
        for (const name of names) {
          if (rel==="." && name===".git") continue;
          if (name.toLowerCase()===".git") throw new Error("OWNER_EVIDENCE_NESTED_REPOSITORY");
          visit(path.join(p,name),rel==="."?name:rel+"/"+name);
        }
        if (JSON.stringify(readdirSync(p).sort())!==JSON.stringify(names)) throw new Error("OWNER_EVIDENCE_DRIFT");
      } else record([rel,sig(s),file(p,s)]);
      if (sig(lstatSync(p))!==sig(s)) throw new Error("OWNER_EVIDENCE_DRIFT");
    };
    const ix=lstatSync(index);
    if (ix.uid!==1000 || ix.gid!==1001 || (ix.mode&0o077)!==0 || ix.dev!==root.dev) throw new Error("OWNER_EVIDENCE_INDEX_POLICY");
    const indexSha256=file(index,ix);
    const refsSha256=hash(git(["show-ref","--head"]));
    const headFile=path.join(gitdir,"HEAD"),hs=lstatSync(headFile);
    if (hs.uid!==1000 || hs.gid!==1001 || (hs.mode&0o077)!==0 || hs.dev!==root.dev) throw new Error("OWNER_EVIDENCE_HEAD_POLICY");
    const headFileSha256=file(headFile,hs);
    visit(cwd,".");
    if (sig(lstatSync(index))!==sig(ix) || sig(lstatSync(headFile))!==sig(hs) || git(["rev-parse","--verify","HEAD"]).toString().trim()!==head || hash(git(["show-ref","--head"]))!==refsSha256) throw new Error("OWNER_EVIDENCE_GIT_DRIFT");
    return {head,indexSha256,refsSha256,headFileSha256,worktreeSha256:digest.digest("hex"),entries,bytes};
  };
  const a=observe(),b=observe();
  if (JSON.stringify(a)!==JSON.stringify(b)) throw new Error("OWNER_EVIDENCE_DRIFT");
  return {ok:true,status:"OWNER_GIT_OBSERVATION",workspacePath:cwd,nonce,actorUid:1000,observation:a,observationSha256:hash(JSON.stringify(a)),writerExclusionProven:false,executionAuthorized:false};
}
