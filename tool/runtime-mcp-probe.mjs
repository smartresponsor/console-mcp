import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function probe({ port, token, timeoutMs = 10000 }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !token) throw Error('invalid_probe');
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  const abort = AbortSignal.timeout(timeoutMs);
  const unauthenticated = await fetch(endpoint, { signal: abort });
  await unauthenticated.body?.cancel();
  if (unauthenticated.status !== 401) throw Error('authentication_not_enforced');
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, signal: abort },
  });
  const client = new Client({ name: 'version-cutover-health', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const listed = await client.listTools({}, { timeout: timeoutMs });
    if (!listed.tools.some(t => t.name === 'read_.system.console.health')) throw Error('health_tool_missing');
    const result = await client.callTool({ name: 'read_.system.console.health', arguments: {} }, undefined, { timeout: timeoutMs });
    const health = result.structuredContent ?? JSON.parse(result.content?.find(c => c.type === 'text')?.text ?? 'null');
    if (result.isError || !health || health.ok !== true) throw Error('mcp_health_failed');
    return { ok: true, initialize: true, toolsList: true, health: true, toolCount: listed.tools.length, pid: health.pid, cwd: health.process?.cwd };
  } finally {
    await client.close();
  }
}
