import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
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
const transcriptDir = path.join(rootDir, "var", "transcript");
const httpTracePath = path.join(transcriptDir, "http-trace.ndjson");
const oauthDebugPath = path.join(transcriptDir, "oauth-debug.ndjson");


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
  CONSOLE_MCP_BROWSER_FACADE_ENABLED: "1",
  CONSOLE_MCP_REPO_FACADE_ENABLED: "1",
  CONSOLE_MCP_OAUTH_JWKS_URI: jwksUri,
  CONSOLE_MCP_TRACE: "1",
  CONSOLE_MCP_OAUTH_DEBUG: "1",
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

try {
 await waitForMetadata(`${consoleOrigin}/.well-known/oauth-protected-resource`);
 const anonymous=await fetch(`${consoleOrigin}/browser/mcp`);
 assert(anonymous.status===401,'OAuth required');
 assert((anonymous.headers.get('WWW-Authenticate')??'').includes('scope="console:write"'),'Write scope challenge');
 const readToken=await new SignJWT({scope:'console:read'}).setProtectedHeader({alg:'RS256',kid:publicJwk.kid}).setIssuer(issuerOrigin).setAudience(consoleOrigin).setIssuedAt().setExpirationTime('5m').sign(issuerKeys.privateKey);
 const denied=await fetch(`${consoleOrigin}/browser/mcp`,{method:'POST',headers:{Authorization:`Bearer ${readToken}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
 assert(denied.status===401,'Read-only token denied');
 const repoDenied=await fetch(`${consoleOrigin}/repo/mcp`,{method:'POST',headers:{Authorization:`Bearer ${readToken}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:11,method:'tools/list',params:{}})});
 assert(repoDenied.status===401,'Read-only token denied on Repo facade');
 const token=await new SignJWT({scope:'console:read console:write'}).setProtectedHeader({alg:'RS256',kid:publicJwk.kid}).setIssuer(issuerOrigin).setAudience(consoleOrigin).setIssuedAt().setExpirationTime('5m').sign(issuerKeys.privateKey);
 async function connect(route) {
  const transport=new StreamableHTTPClientTransport(new URL(`${consoleOrigin}${route}`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
  const client=new Client({name:'browser-facade-http-regression',version:'1.0.0'});
  await client.connect(transport); return {client,transport};
 }
 const browser=await connect('/browser/mcp');
 const tools=(await browser.client.listTools()).tools;
 const expected=JSON.parse(await readFile(path.join(rootDir,'policy','console-tool-admission.json'),'utf8')).declarations.filter(entry=>/^(read_|write)\.web\./.test(entry.name)&&entry.lifecycle==='admitted'&&entry.consumers.includes('chatgpt')).map(entry=>entry.name).sort();
 assert(tools.length===24,`Browser tools/list count: ${tools.length}`);
 assert(JSON.stringify(tools.map(t=>t.name).sort())===JSON.stringify(expected),'Exact canonical Browser tool family');
 assert(tools.some(t=>t.name==='read_.web.session.lease.status'),'Lease published');
 const leaseResponse=await browser.client.callTool({
  name:'read_.web.session.lease.status',arguments:{browserSession:'visible',targetId:'A'.repeat(32)},
 });
 const leaseText=(leaseResponse.content??[]).filter(item=>item.type==='text').map(item=>item.text).join('');
 const lease=JSON.parse(leaseText);
 assert(lease.status==='LEASE_FREE','Read-only lease status callable over actual OAuth MCP transport');
 assert(lease.observation_scope==='local_process'&&lease.cross_process_visibility===false,
   'Lease observation never claimed globally authoritative');

 assert(tools.filter(t=>t.name.startsWith('write.')).every(t=>t._meta?.securitySchemes?.[0]?.scopes?.includes('console:write')),'Write security metadata');
 const forbidden=await browser.client.callTool({name:'read_.system.console.describe',arguments:{}}).then(result=>result.isError===true||/not found|unknown tool|not registered/i.test(JSON.stringify(result)),error=>/not found|unknown tool|not registered/i.test(String(error)));
 assert(forbidden,'Non-browser tool denied');
 await browser.transport.close();await browser.client.close?.();
 const repo=await connect('/repo/mcp');
 const repoTools=(await repo.client.listTools()).tools;
 const expectedRepo=['write.repo.git.merge.reviewed','write.repo.git.archive.ref.push','write.repo.git.push.current.branch','write.repo.git.branch.push','write.repo.git.safe.directory.add','write.repo.git.worktree.create','read_.repo.git.worktree.list','write.repo.git.worktree.remove'].sort();
 assert(JSON.stringify(repoTools.map(t=>t.name).sort())===JSON.stringify(expectedRepo),'Concurrent Repo facade exact tool projection');
 assert(repoTools.every(t=>!t.name.startsWith('read_.web.')&&!t.name.startsWith('write.web.')),'Browser tools cannot leak into Repo facade');
 const repoForbidden=await repo.client.callTool({name:'read_.web.session.lease.status',arguments:{}}).then(result=>result.isError===true||/not found|unknown tool|not registered/i.test(JSON.stringify(result)),error=>/not found|unknown tool|not registered/i.test(String(error)));
 assert(repoForbidden,'Browser command denied on Repo facade');
 await repo.transport.close();await repo.client.close?.();
 const canonical=await connect('/mcp');const normal=(await canonical.client.listTools()).tools;
 assert(normal.length>24&&normal.some(t=>t.name==='read_.system.console.describe'),'Canonical endpoint unchanged');
 await canonical.transport.close();await canonical.client.close?.();
 console.log(JSON.stringify({status:'BROWSER_FACADE_HTTP_GREEN',toolCount:tools.length,oauthWriteRequired:true,readTokenDenied:true,canonicalUnchanged:true,repoFacadeToolCount:repoTools.length,combinedFacadeIsolation:true}));
} finally {
 await closeServer(issuerServer);
 if(!server.killed)server.kill('SIGTERM');
 if(server.exitCode===null&&server.signalCode===null)await once(server,'exit').catch(()=>undefined);
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
