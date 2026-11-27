import { createServer } from "node:http";
import { REPO_FACADE_TOOL_NAMES, OWNER_REPO_FACADE_TOOL_NAMES } from "../dist/engine/repo-facade-tools.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

const issuerKeys = await generateKeyPair("RS256");
const publicJwk = await exportJWK(issuerKeys.publicKey);
publicJwk.kid = "console-mcp-smoke";
publicJwk.use = "sig";
publicJwk.alg = "RS256";

const issuerPort = await getFreePort();
const consolePort = await getFreePort();
const issuerOrigin = `http://127.0.0.1:${issuerPort}/`;
const issuerOriginNoSlash = issuerOrigin.slice(0, -1);
const consoleOrigin = `http://127.0.0.1:${consolePort}`;
const jwksPath = "/.well-known/jwks.json";
const jwksUri = new URL(jwksPath, issuerOrigin).toString();
const scope = "console:write";
const transcriptDir = await mkdtemp(path.join(tmpdir(), "console-mcp-facade-smoke-"));
const httpTracePath = path.join(transcriptDir, "http-trace.ndjson");
const oauthDebugPath = path.join(transcriptDir, "oauth-debug.ndjson");

await rm(httpTracePath, { force: true });
await rm(oauthDebugPath, { force: true });

const issuerServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Missing request URL.");
    return;
  }

  const url = new URL(req.url, issuerOrigin);
  if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      issuer: issuerOrigin,
      jwks_uri: jwksUri,
      token_endpoint: `${issuerOriginNoSlash}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    }));
    return;
  }

  if (url.pathname === jwksPath) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found.");
});

await listen(issuerServer, issuerPort);

const serverEnv = {
  ...process.env,
  CONSOLE_MCP_AUTH_MODE: "oauth",
  CONSOLE_MCP_SERVER_NAME: "oauth-smoke-mcp",
  CONSOLE_MCP_PUBLIC_ORIGIN: consoleOrigin,
  CONSOLE_MCP_OAUTH_ISSUER: issuerOrigin,
  CONSOLE_MCP_OAUTH_AUDIENCE: consoleOrigin,
  CONSOLE_MCP_OAUTH_REQUIRED_SCOPE: "console:read",
  CONSOLE_MCP_OAUTH_WRITE_SCOPE: scope,
  CONSOLE_MCP_TRANSPORT_FACADE_ENABLED: "1",
  CONSOLE_MCP_REPO_FACADE_ENABLED: "1",
  CONSOLE_MCP_RELEASE_TRANSACTION_FACADE_ENABLED: "1",
  CONSOLE_MCP_REPO_OWNER_ROUTING: "0",
  CONSOLE_MCP_OAUTH_JWKS_URI: jwksUri,
  CONSOLE_MCP_TRACE: "1",
  CONSOLE_MCP_OAUTH_DEBUG: "1",
  CONSOLE_MCP_TRANSCRIPT_DIR: transcriptDir,
  CONSOLE_MCP_WORKSPACE_ROOT: transcriptDir,
  CONSOLE_MCP_HOST: "127.0.0.1",
  CONSOLE_MCP_PORT: String(consolePort),
  CONSOLE_MCP_MANAGED_RUNTIME: "watchdog-session-relay",
  CONSOLE_MCP_BEARER_TOKEN: "",
};

const server = spawn(node, ["dist/index.js"], {
  cwd: rootDir,
  env: serverEnv,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

const logs = [];
server.stdout.on("data", (chunk) => logs.push(String(chunk)));
server.stderr.on("data", (chunk) => logs.push(String(chunk)));


async function token(origin, scopes) {
  return new SignJWT({scope:scopes}).setProtectedHeader({alg:"RS256",kid:publicJwk.kid})
    .setIssuer(issuerOrigin).setAudience(origin).setIssuedAt().setExpirationTime("5m").sign(issuerKeys.privateKey);
}
async function list(origin, route, access) {
  const t=new StreamableHTTPClientTransport(new URL(origin+route),{requestInit:{headers:{Authorization:"Bearer "+access}}});
  const c=new Client({name:"eng16-m5-route-delta",version:"1.0.0"});
  try {await c.connect(t);return (await c.listTools()).tools.map(x=>x.name).sort();}
  finally {await c.close().catch(()=>{});await t.close().catch(()=>{});}
}
async function denied(origin,route,access,expected) {
  const r=await fetch(origin+route,{method:"POST",headers:{Authorization:"Bearer "+access,"Content-Type":"application/json",Accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})});
  assert(r.status===expected,route+" status "+r.status+" expected "+expected);
}
try {
 await waitForMetadata(consoleOrigin+"/.well-known/oauth-protected-resource");
 const access=await token(consoleOrigin,"console:read console:write");
 assert(JSON.stringify(await list(consoleOrigin,"/repo/mcp",access))===JSON.stringify([...REPO_FACADE_TOOL_NAMES].sort()),"legacy eight exact");
 const main=await list(consoleOrigin,"/mcp",access);
 assert(REPO_FACADE_TOOL_NAMES.every(n=>!main.includes(n)),"legacy tools excluded from main");
 await denied(consoleOrigin,"/repo/mcp",await token(consoleOrigin,"console:read"),401);
 console.log("ENG16_M5_LEGACY_EXCLUSIVE_HTTP_PASS");
 const port=await getFreePort(),origin="http://127.0.0.1:"+port;
 const child=spawn(node,["dist/index.js"],{cwd:rootDir,env:{...serverEnv,CONSOLE_MCP_REPO_FACADE_ENABLED:"0",CONSOLE_MCP_REPO_OWNER_ROUTING:"1",CONSOLE_MCP_PORT:String(port),CONSOLE_MCP_PUBLIC_ORIGIN:origin,CONSOLE_MCP_OAUTH_AUDIENCE:origin},stdio:["ignore","pipe","pipe"]});
 let childLogs="";child.stdout.on("data",x=>{childLogs+=String(x)});child.stderr.on("data",x=>{childLogs+=String(x)});
 try {
  let ready=false;
  for(let i=0;i<80;i++){if(child.exitCode!==null)break;try{if((await fetch(origin+"/.well-known/oauth-protected-resource")).status===200){ready=true;break}}catch{}await delay(250)}
  assert(ready,"owner-exclusion runtime ready "+childLogs.slice(-2000));
  const auth=await token(origin,"console:read console:write");
  await denied(origin,"/repo/mcp",auth,404);
  for(const route of ["/mcp","/mcp/repo"]){
   const names=await list(origin,route,auth);
   assert(OWNER_REPO_FACADE_TOOL_NAMES.every(n=>!names.includes(n)),"no owner tool leak "+route);
  }
  console.log("ENG16_M5_OWNER_EXCLUSION_HTTP_PASS");
 } finally {if(child.exitCode===null&&child.signalCode===null){child.kill("SIGTERM");await once(child,"exit")}}
 const wrong=spawn(node,["dist/index.js"],{cwd:rootDir,env:{...serverEnv,CONSOLE_MCP_REPO_OWNER_ROUTING:"1",CONSOLE_MCP_REPO_FACADE_ENABLED:"1"},stdio:["ignore","pipe","pipe"]});
 let wrongLogs="";wrong.stderr.on("data",x=>{wrongLogs+=String(x)});
 try {const [code]=await once(wrong,"exit");assert(code!==0&&wrongLogs.includes("Repo owner facade requires UID 1000"),"wrong UID rejected");}
 finally {if(wrong.exitCode===null&&wrong.signalCode===null)wrong.kill("SIGTERM")}
 console.log("ENG16_M5_WRONG_UID_HTTP_STARTUP_DENIED");
} finally {
 await closeServer(issuerServer);
 if(server.exitCode===null&&server.signalCode===null){server.kill("SIGTERM");await once(server,"exit")}
 await rm(transcriptDir,{recursive:true,force:true});
}
function assert(condition, label) {
  if (!condition) {
    throw new Error(`OAuth smoke assertion failed: ${label}`);
  }
}

function readTextResult(result) {
  const content = result.content ?? [];
  return content.map((item) => item.type === "text" ? item.text : "").join("\n");
}

async function readNdjson(filePath) {
  const text = await readFile(filePath, "utf8");
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForMetadata(url) {
  for (let i = 0; i < 80; i += 1) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`OAuth smoke server exited (code=${server.exitCode}, signal=${server.signalCode}).\n${logs.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) {
        return;
      }
    } catch {
      // retry
    }

    await delay(250);
  }

  throw new Error(`console-mcp metadata endpoint did not become ready in time.\n${logs.join("")}`);
}

async function getFreePort() {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await closeServer(server);
  if (!port) {
    throw new Error("Unable to allocate a free port.");
  }

  return port;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
