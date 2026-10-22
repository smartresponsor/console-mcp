import { z } from "zod";
import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";

// RC staging only; deliberately not installed into the production registration.
export const gitRemoteAddInput=z.object({
 workspacePath:z.string().min(1),
 remote:z.literal("origin").default("origin"),
 repository:z.literal("smartresponsor/console-mcp"),
 confirmAdd:z.boolean().default(false)
}).strict();

export async function addGuardedGitRemote(policy:ConsolePolicy,input:unknown){
 const params=gitRemoteAddInput.parse(input);
 const cwd=assertAllowedRoot(params.workspacePath,policy.allowedRoots);
 if(!existsSync(path.join(cwd,".git")))return {ok:false,status:"GIT_REPOSITORY_REQUIRED"};
 // Restrict to the dedicated, disposable RC checkout, never the live checkout.
 if(path.basename(cwd)!=="console-mcp-infra-rc1-20261022")
   return {ok:false,status:"RC_WORKSPACE_REQUIRED"};
 const existing=await runSupervisedCommand(cwd,"git",["remote","get-url","origin"],10000,4096);
 if(existing.ok)return {ok:false,status:"REMOTE_ALREADY_EXISTS"};
 if(existing.exitCode!==2)return {ok:false,status:"REMOTE_INSPECTION_FAILED"};
 if(!params.confirmAdd)return {ok:false,status:"CONFIRMATION_REQUIRED"};
 const url="https://github.com/smartresponsor/console-mcp.git";
 const action=await runSupervisedCommand(cwd,"git",["remote","add","origin",url],10000,4096);
 return action.ok?{ok:true,status:"REMOTE_ADDED",remote:"origin",repository:params.repository}:
  {ok:false,status:"REMOTE_ADD_FAILED"};
}
export function registerGitRemoteAddDraft(server:McpServer,policy:ConsolePolicy,authConfig:ConsoleAuthConfig):void{
 server.registerTool("write.repo.git.remote.add",{
  description:"Add the approved Console MCP origin only to the isolated RC1 workspace.",
  inputSchema:gitRemoteAddInput,...buildConsoleMutationToolRegistration(authConfig)
 },async input=>textResult(await addGuardedGitRemote(policy,input)));
}
