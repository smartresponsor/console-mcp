import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolDirectory, '..');
const tracePath = join(root, 'var', 'transcript', 'http-trace.ndjson');
const endpointPath = '/mcp';

async function allocatePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a loopback port.'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForServer(url, child) {
  const acceptedStatuses = new Set([200, 401, 404, 405]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Console MCP exited before becoming ready (exit code ${child.exitCode}).`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (acceptedStatuses.has(response.status)) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Console MCP did not become ready at ${url}.`);
}

async function httpStatus(url, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  await response.body?.cancel();
  return response.status;
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function assertTrace() {
  if (!existsSync(tracePath)) throw new Error('HTTP trace was not written.');
  const lines = readFileSync(tracePath, 'utf8').split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) throw new Error('HTTP trace is empty.');
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (!Object.hasOwn(entry, 'path')) throw new Error('HTTP trace entry is missing path.');
    if (!Object.hasOwn(entry, 'status_code')) throw new Error('HTTP trace entry is missing status_code.');
    if (Object.hasOwn(entry, 'authorization')) throw new Error('HTTP trace leaked raw authorization content.');
    if (entry.authorization_scheme && entry.authorization_scheme !== 'Bearer') {
      throw new Error(`Unexpected authorization scheme: ${entry.authorization_scheme}`);
    }
  }
}

mkdirSync(dirname(tracePath), { recursive: true });
rmSync(tracePath, { force: true });

const port = await allocatePort();
const token = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
const endpoint = `http://127.0.0.1:${port}${endpointPath}`;
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    CONSOLE_MCP_HOST: '127.0.0.1',
    CONSOLE_MCP_PORT: String(port),
    CONSOLE_MCP_AUTH_MODE: 'bearer',
    CONSOLE_MCP_BEARER_TOKEN: token,
    CONSOLE_MCP_TRACE: '1',
    CONSOLE_MCP_MANAGED_RUNTIME: 'smoke-test',
    CONSOLE_MCP_WORKSPACE_ROOT: root,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

try {
  await waitForServer(endpoint, child);
  const missingTokenStatus = await httpStatus(endpoint);
  const wrongTokenStatus = await httpStatus(endpoint, 'definitely-wrong-token');
  const goodTokenStatus = await httpStatus(endpoint, token);

  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'console-mcp-smoke', version: '1.0.0' });
  await client.connect(transport);
  try {
    const listTools = await client.listTools();
    const call = (name, args) => client.callTool({ name, arguments: args });
    const deniedPath = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    const result = {
      list_tools: listTools.tools.map((tool) => tool.name).sort(),
      describe: await call('console.read_.system.console.describe', {}),
      health: await call('console.read_.system.console.health', {}),
      workspace_status: await call('console.read_.repo.workspace.status', { workspacePath: root }),
      capture_context: await call('console.read_.repo.context.capture', { workspacePath: root }),
      search_text: await call('console.read_.repo.text.search', { workspacePath: root, query: 'console-mcp', maxResults: 3 }),
      read_file_refusal: await call('console.read_.repo.file.read', { filePath: deniedPath }),
      unknown_check_refusal: await call('console.read_.repo.gate.check.run', { workspacePath: root, checkName: 'unknown_check' }),
      git_status: await call('console.read_.repo.gate.check.run', { workspacePath: root, checkName: 'git_status' }),
    };
    const requiredSuccesses = ['workspace_status', 'capture_context', 'search_text', 'git_status'];
    for (const key of requiredSuccesses) {
      if (result[key]?.isError) {
        throw new Error(`Smoke operation ${key} failed: ${JSON.stringify(result[key])}`);
      }
    }
    if (!result.read_file_refusal?.isError) {
      throw new Error('Denied-path smoke assertion did not refuse the external file.');
    }
    if (!result.unknown_check_refusal?.isError) {
      throw new Error('Unknown-check smoke assertion did not refuse the unregistered check.');
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await transport.close();
  }

  console.log(`missing_token_http=${missingTokenStatus}`);
  console.log(`wrong_token_http=${wrongTokenStatus}`);
  console.log(`good_token_http=${goodTokenStatus}`);
  assertTrace();
} finally {
  await stopProcess(child);
  if (child.exitCode && stderr.trim()) console.error(stderr.trim());
}
