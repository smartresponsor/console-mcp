import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "linux") process.exit(0);
const root = await mkdtemp(path.join(tmpdir(), "stage11-node-fence-"));
await chmod(root, 0o700);
const directory=path.join(root,"inflight");
const lock=path.join(root,"admission.lock");
await mkdir(directory,{mode:0o700});
await writeFile(lock,"preprovisioned",{mode:0o640});
const orig=fileURLToPath(new URL("../dist/Infrastructure/Process/DeploymentAdmission.js",import.meta.url));
const copy=orig.replace(/DeploymentAdmission\.js$/, "DeploymentAdmission.stage11-fixture.mjs");
const pyOriginal=fileURLToPath(new URL("../ops/ubuntu/deployment/admission-lock.py",import.meta.url));
const pyFixture=path.join(root,"helper-fixture.py");
const old=process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION;
const helperCode = [
  "import importlib.util,os,sys",
  "from pathlib import Path",
  "s=importlib.util.spec_from_file_location('ad', "+JSON.stringify(pyOriginal)+")",
  "m=importlib.util.module_from_spec(s)",
  "s.loader.exec_module(m)",
  "m.hold_session('shared',max_seconds=120,directory=Path("+JSON.stringify(directory)+"),lock_path=Path("+JSON.stringify(lock)+"),expected_uid=os.getuid())",
  "",
].join("\n");
const markers=()=>readdir(directory);
try {
  await writeFile(pyFixture,helperCode,{mode:0o600});
  const source=await readFile(orig,"utf8");
  assert.equal(source.split('const HELPER = "/opt/console-mcp-deploy/admission-lock.py";').length-1,1);
  await writeFile(copy,source.replace('const HELPER = "/opt/console-mcp-deploy/admission-lock.py";',
    'const HELPER = '+JSON.stringify(pyFixture)+';'),{flag:"wx",mode:0o600});
  const { withDeploymentSharedAdmission }=await import(pathToFileURL(copy).href);
  process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION="required";

  assert.equal(await withDeploymentSharedAdmission(async()=> {
    assert.equal((await markers()).length,1);
    return "completed";
  }),"completed");
  assert.equal((await markers()).length,0,"explicit release removes marker only after callback");

  await assert.rejects(()=>withDeploymentSharedAdmission(async()=> {
    throw new Error("CALLBACK_INTENTIONALLY_FAILED");
  }), /CALLBACK_INTENTIONALLY_FAILED/);
  assert.equal((await markers()).length,0,"settled rejected callback releases the fence");

  let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  let finish;
  const unfinished=new Promise(resolve=>{finish=resolve;});
  const pending=withDeploymentSharedAdmission(async()=>{
    entered();
    await unfinished;
    return "must-not-succeed";
  });
  await started;
  const found=await markers();
  assert.equal(found.length,1);
  const record=JSON.parse(await readFile(path.join(directory,found[0]),"utf8"));
  assert.ok(record.pid>0);
  process.kill(record.pid,"SIGKILL");
  await delay(100);
  finish();
  await assert.rejects(pending,/DEPLOYMENT_ADMISSION_HELPER_LOST_FENCE_RETAINED/);
  assert.equal((await markers()).length,1,"killed helper cannot clear its durable fence");
  console.log("STAGE11_NODE_HELPER_SIGKILL_DURING_CALLBACK_FAIL_CLOSED_PASS");
} finally {
  if(old===undefined) delete process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION;
  else process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION=old;
  await rm(copy,{force:true});
  await rm(root,{recursive:true,force:true});
}
