import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Inject a single failing dedupe publication into a disposable *compiled*
// module copy. This modifies neither the source nor any runtime controller.
if (process.platform !== "linux") process.exit(0);
const original = fileURLToPath(new URL("../dist/Infrastructure/Process/AsyncCommandRun.js", import.meta.url));
const injected = original.replace(/AsyncCommandRun\.js$/, "AsyncCommandRun.stage11-fixture.mjs");
const workspace = await mkdtemp(path.join(os.tmpdir(), "stage11-postspawn-"));
const prior = process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION;
try {
  const source = await readFile(original, "utf8");
  const needle = "await writeDedupeLease(dedupe, state);";
  assert.equal(source.split(needle).length - 1, 1, "unique post-spawn dedupe publication");
  await writeFile(injected, source.replace(needle, 'throw new Error("STAGE11_INJECTED_POSTSPAWN_FAILURE");'), {flag:"wx",mode:0o600});
  const {startAsyncCommandRun}=await import(pathToFileURL(injected).href);
  process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION="disabled";
  await assert.rejects(() => startAsyncCommandRun({
    workspacePath:workspace, command:process.execPath,
    args:["-e","setInterval(()=>{},1000)"], timeoutMs:15000,
    kind:"stage11-postspawn-failure",
    dedupe:{operationKey:"stage11",repositoryFingerprint:"isolated"},
  }), /STAGE11_INJECTED_POSTSPAWN_FAILURE/);
  const directory=path.join(workspace,".console-mcp","command-run");
  const runs=await readdir(directory);
  assert.equal(runs.length,1,"spawn must complete before injected failure");
  const state=JSON.parse(await readFile(path.join(directory,runs[0],"state.json"),"utf8"));
  assert.ok(state.pid>0);
  assert.throws(()=>process.kill(state.pid,0),{code:"ESRCH"},"spawned child must be reaped");
  assert.throws(()=>process.kill(-state.pid,0),{code:"ESRCH"},"spawned child process group must be absent");
  console.log("STAGE11_REAL_POSTSPAWN_FAILURE_REAP_PASS");
} finally {
  if(prior===undefined) delete process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION;
  else process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION=prior;
  await rm(injected,{force:true});
  await rm(workspace,{recursive:true,force:true});
}
