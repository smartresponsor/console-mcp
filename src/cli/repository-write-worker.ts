import { createServer } from "node:net";
import { lstat, chmod, realpath } from "node:fs/promises";
import path from "node:path";
import { loadConsolePolicy } from "../Policy/ConsolePolicy.js";
import { replaceTextInFile, type ReplaceInFileInput } from "../Infrastructure/FileSystem/FileEdit.js";

const socketPath = process.env.CONSOLE_MCP_REPO_WRITE_SOCKET;
const policyRoot = process.env.CONSOLE_MCP_REPO_WRITE_POLICY_ROOT;
if (!socketPath || !path.isAbsolute(socketPath) || !policyRoot || !path.isAbsolute(policyRoot)) {
  throw new Error("Explicit absolute socket and policy root are required");
}
const socket = socketPath;
const policy = await loadConsolePolicy(policyRoot);
const maxRequestBytes = 1024 * 1024;

const server = createServer((client) => {
  let buffer = "";
  let handled = false;
  client.setTimeout(15000, () => client.destroy());
  client.on("data", (chunk: Buffer) => {
    if (handled) return;
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > maxRequestBytes) {
      handled = true;
      client.destroy();
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    void (async () => {
      let id: string | null = null;
      try {
        const parsed: unknown = JSON.parse(buffer.slice(0, newline));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid request");
        const request = parsed as Record<string, unknown>;
        if (typeof request.id !== "string" || !/^[a-f0-9-]{36}$/i.test(request.id)) throw new Error("Invalid request ID");
        id = request.id;
        if (Object.keys(request).some((key) => !["id", "operation", "input"].includes(key))) throw new Error("Unexpected request fields");
        if (request.operation !== "replaceText" || !request.input || typeof request.input !== "object" || Array.isArray(request.input)) throw new Error("Operation denied");
        const input = request.input as Record<string, unknown>;
        if (typeof input.workspacePath !== "string" || typeof input.filePath !== "string" ||
            typeof input.search !== "string" || !input.search ||
            typeof input.replace !== "string" ||
            (input.expectedOccurrences !== undefined && (!Number.isInteger(input.expectedOccurrences) || Number(input.expectedOccurrences) < 1)) ||
            (input.dryRun !== undefined && typeof input.dryRun !== "boolean") ||
            (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 1000)) ||
            Object.keys(input).some((key) => !["workspacePath","filePath","search","replace","expectedOccurrences","dryRun","reason"].includes(key))) {
          throw new Error("Invalid input");
        }
        const workspacePath = path.resolve(input.workspacePath as string);
        const targetPath = path.resolve(workspacePath, input.filePath as string);
        const [realWorkspace, realTarget] = await Promise.all([realpath(workspacePath), realpath(targetPath)]);
        if (realWorkspace !== workspacePath || realTarget !== targetPath) {
          throw new Error("Repository write through symlinks is denied");
        }
        if (input.dryRun !== true) {
          throw new Error("Writable IPC mutation is disabled pending race-safe file operations and E2E acceptance");
        }
        const result = await replaceTextInFile(policy, input as ReplaceInFileInput);
        client.end(JSON.stringify({ id, ok: true, result }) + "\n");
      } catch (error) {
        client.end(JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : "Rejected" }) + "\n");
      }
    })();
  });
});
try {
  await lstat(socket);
  throw new Error("Socket path already exists; refusing to replace it");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
server.listen(socket, async () => {
  try { await chmod(socket, 0o600); }
  catch { server.close(); }
});
