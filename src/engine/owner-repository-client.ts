import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { randomBytes, createHash } from "node:crypto";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { OWNER_REPO_FACADE_TOOL_NAMES } from "./repo-facade-tools.js";
import { getToolAdmissionDeclaration, declarationVisibleToConsumer } from "./tool-admission.js";

type OwnerConsumer = "codex" | "runner";
export function validateOwnerEndpoint(value: string): URL {
  const u = new URL(value);
  if (u.username || u.password || u.hash || u.search || u.pathname !== "/repo/mcp" ||
      !(u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "127.0.0.1"))) throw new Error("OWNER_ENDPOINT_INVALID");
  return u;
}

export async function connectOwnerRepositoryClient(consumer: OwnerConsumer, endpoint: string, accessToken: string) {
  if (consumer !== "codex" && consumer !== "runner") throw new Error("OWNER_CONSUMER_INVALID");
  const u = validateOwnerEndpoint(endpoint);
  if (!accessToken || accessToken.length > 16384 || /\s/.test(accessToken)) throw new Error("OWNER_OAUTH_TOKEN_REQUIRED");
  // Match the default owner facade publication contract; held documentating tools stay excluded.
  const published = new Set<string>(OWNER_REPO_FACADE_TOOL_NAMES.filter(n => !n.startsWith("write.repo.documentating.site.")));
  const names = new Set<string>([...published].filter(n => declarationVisibleToConsumer(getToolAdmissionDeclaration(n), consumer)));
  // Operator supplied endpoint/token only; no discovery, automatic login, bearer forwarding or redirects.
  const transport = new StreamableHTTPClientTransport(u, {
    requestInit: { headers: { Authorization: "Bearer " + accessToken }, redirect: "error" },
    reconnectionOptions: { maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
    fetch: async (input, init) => {
      const actual = new URL(input instanceof Request ? input.url : String(input));
      if (actual.href !== u.href) throw new Error("OWNER_ENDPOINT_REDIRECT_DENIED");
      return fetch(input, {...init, redirect:"error"});
    },
  });
  const client = new Client({name:"eng16-owner-"+consumer,version:"1.0.0"});
  try {
    await client.connect(transport);
    const tools: Tool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page=0;page<10;page++) {
      const response = await client.listTools(cursor ? {cursor} : {});
      for (const t of response.tools) {
        if (!published.has(t.name) || seen.has(t.name)) throw new Error("OWNER_REMOTE_PROJECTION_MISMATCH");
        seen.add(t.name); if (names.has(t.name)) tools.push(t);
      }
      cursor=response.nextCursor;
      if (!cursor) break;
    }
    if (cursor || [...published].some(n=>!seen.has(n))) throw new Error("OWNER_REMOTE_PROJECTION_INCOMPLETE");
    return {
      tools,
      call: async (name: string, args: Record<string, unknown>) => {
        if (!names.has(name)) throw new Error("OWNER_TOOL_NOT_ADMITTED");
        // Do not retry an ambiguous mutation result; the caller must reconcile state.
        return client.callTool({name,arguments:args},undefined,{timeout:180000});
      },
      observe: async (workspacePath: string) => {
        if (!names.has("read_.repo.workspace.status")) throw new Error("OWNER_TOOL_NOT_ADMITTED");
        const nonce=randomBytes(32).toString("hex");
        const result=await client.callTool({name:"read_.repo.workspace.status",arguments:{workspacePath,evidenceNonce:nonce}});
        const content=result.content;
        const payload=(result.structuredContent ?? (Array.isArray(content) && content[0]?.type==="text" ? JSON.parse(String(content[0].text)) : null)) as Record<string,unknown> | null;
        if (!payload || result.isError || payload.ok!==true || payload.status!=="OWNER_GIT_OBSERVATION" || payload.nonce!==nonce ||
            payload.workspacePath!==workspacePath || payload.actorUid!==1000 || payload.executionAuthorized!==false ||
            payload.writerExclusionProven!==false || !payload.observation ||
            createHash("sha256").update(JSON.stringify(payload.observation)).digest("hex")!==payload.observationSha256) throw new Error("OWNER_GIT_OBSERVATION_INVALID");
        return payload;
      },
      close: async () => { await client.close(); await transport.close(); },
    };
  } catch (e) { await client.close().catch(()=>undefined); await transport.close().catch(()=>undefined); throw e; }
}

export async function runOwnerRepositoryStdio(): Promise<void> {
  const consumer=process.env.CONSOLE_OWNER_CLIENT_CONSUMER;
  if (consumer!=="codex" && consumer!=="runner") throw new Error("OWNER_CONSUMER_INVALID");
  const endpoint=process.env.CONSOLE_OWNER_CLIENT_ENDPOINT ?? "";
  const token=process.env.CONSOLE_OWNER_CLIENT_ACCESS_TOKEN ?? "";
  if (token && [process.env.CONSOLE_MCP_BEARER_TOKEN,process.env.CONSOLE_MCP_BEARER_TOKEN_PREVIOUS].includes(token)) throw new Error("OWNER_TOKEN_MUST_BE_SEPARATELY_AUTHORIZED");
  delete process.env.CONSOLE_OWNER_CLIENT_ACCESS_TOKEN;
  const owner=await connectOwnerRepositoryClient(consumer,endpoint,token);
  const server=new Server({name:"eng16-owner-"+consumer,version:"1.0.0"},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:owner.tools}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    try { return await owner.call(request.params.name,request.params.arguments??{}); }
    catch { return {isError:true,content:[{type:"text",text:"OWNER_CALL_FAILED_OR_UNADMITTED: reconcile remote state before retrying."}]}; }
  });
  server.onclose=()=>{void owner.close();};
  await server.connect(new StdioServerTransport());
}
