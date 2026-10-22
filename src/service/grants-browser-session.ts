import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
const exec = promisify(execFile);
const PORT=9230, USER="console-mcp-grants", SERVICE="console-mcp-grants-browser.service";
const PROFILE="/var/lib/console-mcp-grants-browser/profile", ENDPOINT="http://127.0.0.1:9230";
const validId=/^[a-fA-F0-9]{32}$/;
export type GrantsEvidence={endpoint:string;browserInstance:string;targetId:string;browserPid:number;owner:string;profile:string;url:string;verifiedAt:string};
export type GrantsProof={ok:boolean;status:string;reason:string;states:string[];evidence:GrantsEvidence|null;visibility_verified:false;user_interaction_ready:false;automatic_retry_allowed:false};
const fail=(reason:string):GrantsProof=>({ok:false,status:"WEB_GRANTS_SESSION_NOT_READY",reason,states:[],evidence:null,visibility_verified:false,user_interaction_ready:false,automatic_retry_allowed:false});
export function isGrantsAllowedUrl(value:string):boolean{
  if(value==="about:blank")return true;
  try{const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&(u.hostname==="humanityai.ai"||u.hostname.endsWith(".humanityai.ai")||u.hostname==="submittable.com"||u.hostname.endsWith(".submittable.com"))}catch{return false}
}
export function sameGrantsTarget(a:GrantsEvidence,b:GrantsEvidence):boolean{return a.endpoint===b.endpoint&&a.browserInstance===b.browserInstance&&a.targetId===b.targetId&&a.browserPid===b.browserPid&&a.owner===b.owner&&a.profile===b.profile}
export async function inspectGrantsTarget({targetId,expected,destinationUrl,proofLevel="worker"}:{targetId?:string;expected?:GrantsEvidence;destinationUrl?:string;proofLevel?:"worker"|"console"}={}):Promise<GrantsProof>{
  if(destinationUrl&&!isGrantsAllowedUrl(destinationUrl))return fail("GRANTS_HOST_NOT_ALLOWED");
  if(targetId&&!validId.test(targetId))return fail("GRANTS_TARGET_ID_INVALID");
  try{
    const unit=await exec("systemctl",["show",SERVICE,"--property=ActiveState","--property=MainPID","--property=User","--no-pager"],{timeout:2500,maxBuffer:16000});
    const meta=Object.fromEntries(unit.stdout.trim().split("\n").map(line=>{const ix=line.indexOf("=");return [line.slice(0,ix),line.slice(ix+1)]}));
    const pid=Number(meta.MainPID);
    if(meta.ActiveState!=="active"||meta.User!==USER||!Number.isSafeInteger(pid)||pid<=0)return fail("GRANTS_UNIT_IDENTITY_UNVERIFIED");
    if (proofLevel === "console") {
      // Console MCP has ProtectProc=invisible and cannot inspect the dedicated user's /proc.
      // Require the independently owned and authenticated worker systemd unit to be active.
      // That worker must re-attest the browser PID, UID, profile and instance for every request.
      const workerUnit = await exec("systemctl", ["show", "console-mcp-grants-web-worker.service",
        "--property=ActiveState", "--property=MainPID", "--property=User", "--no-pager"],
        { timeout: 2500, maxBuffer: 16000 });
      const values = Object.fromEntries(workerUnit.stdout.trim().split("\n").map(row => {
        const ix = row.indexOf("="); return [row.slice(0, ix), row.slice(ix + 1)];
      }));
      if (values.ActiveState !== "active" || values.User !== "console-mcp" ||
          !Number.isSafeInteger(Number(values.MainPID)) || Number(values.MainPID) <= 0)
        return fail("GRANTS_SEMANTIC_WORKER_IDENTITY_UNVERIFIED");
    } else {
      const cmd = (await readFile("/proc/" + pid + "/cmdline", "utf8")).split("\0").filter(Boolean);
      if (!cmd.includes("--remote-debugging-port=9230") ||
          !cmd.includes("--user-data-dir=" + PROFILE) || cmd.includes("--no-sandbox"))
        return fail("GRANTS_PROCESS_IDENTITY_UNVERIFIED");
      const [info, uid] = await Promise.all([
        stat("/proc/" + pid),
        exec("id", ["-u", USER], { timeout: 2500, maxBuffer: 1024 })
      ]);
      if (info.uid !== Number(uid.stdout.trim())) return fail("GRANTS_PROCESS_OWNER_MISMATCH");
    }
    const get=async(path:string):Promise<any>=>{const r=await fetch(ENDPOINT+path,{signal:AbortSignal.timeout(2500)});if(!r.ok)throw Error("CDP_HTTP");return r.json()};
    const [version,targets]=await Promise.all([get("/json/version"),get("/json/list")]);
    const ws=new URL(String(version.webSocketDebuggerUrl||""));
    if(ws.protocol!=="ws:"||ws.hostname!=="127.0.0.1"||ws.port!=="9230"||!ws.pathname.startsWith("/devtools/browser/"))return fail("GRANTS_CDP_INSTANCE_INVALID");
    const pages=(Array.isArray(targets)?targets:[]).filter(t=>t.type==="page"&&validId.test(t.id));
    const matches=targetId?pages.filter(t=>t.id===targetId):pages;
    if(matches.length!==1)return fail(matches.length?"GRANTS_TARGET_AMBIGUOUS":"GRANTS_TARGET_NOT_FOUND");
    const url=String(matches[0].url||"");
    if(!isGrantsAllowedUrl(url))return fail("GRANTS_TARGET_OUTSIDE_ALLOWED_HOSTS");
    const evidence={endpoint:ENDPOINT,browserInstance:ws.pathname,targetId:matches[0].id,browserPid:pid,owner:USER,profile:PROFILE,url,verifiedAt:new Date().toISOString()};
    if(expected&&!sameGrantsTarget(expected,evidence))return fail("GRANTS_TARGET_CHANGED");
    return {ok:true,status:"GRANTS_TARGET_BOUND",reason:"VERIFIED",states:["CDP_CONNECTED","BROWSER_TARGET_EXISTS","GRANTS_SERVICE_OWNER_VERIFIED","GRANTS_TARGET_BOUND"],evidence,visibility_verified:false,user_interaction_ready:false,automatic_retry_allowed:false};
  }catch{return fail("GRANTS_PROOF_UNAVAILABLE")}
}
