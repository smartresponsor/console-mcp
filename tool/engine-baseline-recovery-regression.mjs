import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createEnginePaths, enqueueTask, recordEngineExecutionSpecification, getEngineTaskStatus, recoverEnginePreSubmitBaseline, authorizeEngineTaskExecution, hasEngineGitBaseline } from "../dist/engine/engine-core.js";
import { runEngineCycleStep } from "../dist/engine/engine-cycle.js";

const root = await mkdtemp(path.join(tmpdir(), "engine-baseline-recovery-"));
const workspace = path.join(root, "fixture");
const paths = createEnginePaths(path.join(root, "runtime"), root);
const hash = text => createHash("sha256").update(text).digest("hex");
try {
  // Deliberately place the fixture inside a parent Git repository.
  execFileSync("git", ["init", "--quiet"], {cwd:root});
  execFileSync("git", ["-c","commit.gpgsign=false","-c","core.hooksPath=/dev/null","-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-qm","parent"], {cwd:root});
  await mkdir(workspace);
  const enqueue = await enqueueTask(paths, "fixture", true, "cli", workspace);
  assert.equal(enqueue.ok, true);
  const id = enqueue.task_id;
  const spec = await recordEngineExecutionSpecification(paths, id, {content:"Read only fixture", sourcePrompt:"Read only fixture", mutationPolicy:"read_only"});
  assert.equal(spec.ok, true);
  const initial = (await getEngineTaskStatus(paths, id)).task;
  assert.equal(hasEngineGitBaseline(initial), false);
  assert.equal((await authorizeEngineTaskExecution(paths, id, {authorizedBy:"go", maxAutoIterations:2})).ok, false);
  assert.equal((await recoverEnginePreSubmitBaseline(paths, id)).status, "ENGINE_READ_ONLY_BASELINE_UNAVAILABLE");
  const original = await readFile(initial.run_spec_path, "utf8");
  const taskFile = path.join(paths.taskDir, id + ".json");
  const bound = {...initial, chat_id:"fixture-chat", target_id:"fixture-target", composer_ready_at:new Date().toISOString(), composer_preflight_target_id:"fixture-target"};
  await writeFile(taskFile, JSON.stringify(bound));
  let called = false;
  const blocked = await runEngineCycleStep(paths, {taskId:id, mode:"execute"}, {executeStage:async()=>{called=true; return {ok:true};}});
  assert.equal(blocked.reason, "ENGINE_READ_ONLY_BASELINE_UNAVAILABLE");
  assert.equal(called,false);
  execFileSync("git", ["init", "--quiet"], {cwd:workspace});
  execFileSync("git", ["-c","commit.gpgsign=false","-c","core.hooksPath=/dev/null","-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-qm","fixture"], {cwd:workspace});
  // Simulate a crashed preparer: an orphan revision must not be treated as
  // published while the task still references its original RunSpec.
  const orphan = path.join(paths.sessionDir, "run-spec-" + id + "-" + "0".repeat(64) + ".json");
  await writeFile(orphan, "{}");
  const busyLock = path.join(paths.lockDir,id+".cycle.lock");
  await writeFile(busyLock, "{}");
  assert.equal((await recoverEnginePreSubmitBaseline(paths,id)).status,"ENGINE_TASK_BUSY");
  await rm(busyLock);
  const attempts = await Promise.all([recoverEnginePreSubmitBaseline(paths,id),recoverEnginePreSubmitBaseline(paths,id)]);
  assert.equal(attempts.filter(x=>x.ok===true).length,1,JSON.stringify(attempts));
  assert.ok(attempts.some(x=>["ENGINE_TASK_BUSY","ENGINE_BASELINE_ALREADY_PRESENT"].includes(x.status)));
  const result = attempts.find(x=>x.ok===true);
  assert.equal(result.ok,true,JSON.stringify(result));
  const recovered = (await getEngineTaskStatus(paths,id)).task;
  assert.equal(hasEngineGitBaseline(recovered),true);
  assert.equal(recovered.task_id,id);
  assert.equal(recovered.chat_id,"fixture-chat");
  assert.equal(recovered.target_id,"fixture-target");
  assert.equal(recovered.execution_specification_hash,initial.execution_specification_hash);
  assert.notEqual(recovered.execution_authorized,true);
  assert.equal(await readFile(initial.run_spec_path,"utf8"),original);
  const revision = await readFile(recovered.run_spec_path,"utf8");
  assert.equal(hash(revision),recovered.run_spec_hash);
  const parsed = JSON.parse(revision);
  assert.equal(parsed.baseline_recovery.previous_run_spec_hash,hash(original));
  assert.equal(parsed.initial_head,recovered.initial_head);
  assert.equal(parsed.initial_git_status_hash,recovered.initial_git_status_hash);
  assert.equal(parsed.initial_worktree_fingerprint,recovered.initial_worktree_fingerprint);
  assert.equal((await recoverEnginePreSubmitBaseline(paths,id)).status,"ENGINE_BASELINE_ALREADY_PRESENT");
  const authorized = await authorizeEngineTaskExecution(paths,id,{authorizedBy:"go",maxAutoIterations:2});
  assert.equal(authorized.ok,true);
  assert.equal(authorized.max_auto_iterations,2);
  await writeFile(taskFile,JSON.stringify({...bound,submitted_at:new Date().toISOString()}));
  assert.equal((await recoverEnginePreSubmitBaseline(paths,id)).status,"ENGINE_BASELINE_RECOVERY_NOT_SAFE");
  await writeFile(taskFile,JSON.stringify(bound));
  await writeFile(initial.run_spec_path,original+" ");
  assert.equal((await recoverEnginePreSubmitBaseline(paths,id)).status,"ENGINE_BASELINE_RECOVERY_SPEC_HASH_MISMATCH");
  await writeFile(initial.run_spec_path,original);
  if (process.platform !== "win32") {
    // Intercept only the publication rename in a separate process, using
    // Node's builtin ESM synchronization before importing the engine.
    const moduleUrl = new URL("../dist/engine/engine-core.js", import.meta.url).href;
    for (const boundary of ["before","after"]) {
      await writeFile(taskFile,JSON.stringify(bound));
      const childCode = `
        import fs from "node:fs/promises";
        import {syncBuiltinESMExports} from "node:module";
        const rename = fs.rename;
        fs.rename = async (src,dst) => {
          if (dst === process.argv[1]) {
            if (process.argv[2] === "after") await rename(src,dst);
            process.kill(process.pid,"SIGKILL");
            return;
          }
          return rename(src,dst);
        };
        syncBuiltinESMExports();
        const engine = await import(${JSON.stringify(moduleUrl)});
        await engine.recoverEnginePreSubmitBaseline(JSON.parse(process.argv[3]),process.argv[4]);
        process.exit(91);
      `;
      const child = spawn(process.execPath,["--input-type=module","-e",childCode,taskFile,boundary,JSON.stringify(paths),id],{stdio:"inherit"});
      const [code,signal] = await once(child,"exit");
      assert.equal(signal,"SIGKILL", "publication boundary not reached: "+code);
      const observed = (await getEngineTaskStatus(paths,id)).task;
      assert.equal(hasEngineGitBaseline(observed),boundary==="after");
      assert.notEqual(observed.execution_authorized,true);
      if(boundary==="after") assert.equal(hash(await readFile(observed.run_spec_path,"utf8")),observed.run_spec_hash);
      else assert.equal(observed.run_spec_hash,initial.run_spec_hash);
      // Test-only removal of the dead child's lock, confined to this fixture.
      await rm(path.join(paths.lockDir,id+".management.lock"),{force:true});
    }
    console.log("ENGINE_BASELINE_SIGKILL_BOUNDARIES_GREEN");
  }
  console.log("ENGINE_BASELINE_RECOVERY_GREEN");
} finally {
  await rm(root,{recursive:true,force:true});
}
