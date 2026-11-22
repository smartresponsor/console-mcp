import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ReplaceInFileInput, ReplaceInFileResult } from "../FileSystem/FileEdit.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15000;

/** An uncertain write is never retried automatically. */
export function replaceViaRepositoryWriteSocket(socketPath: string, input: ReplaceInFileInput): Promise<ReplaceInFileResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    const requestId = randomUUID();
    let buffer = "";
    let receivedBytes = 0;
    const decoder = new StringDecoder("utf8");
    let completed = false;
    const fail = (error: Error) => {
      if (completed) return;
      completed = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(TIMEOUT_MS, () => fail(new Error("Repository write request timed out; outcome unknown")));
    socket.once("error", fail);
    socket.once("connect", () => {
      const message = JSON.stringify({ id: requestId, operation: "replaceText", input }) + "\n";
      if (Buffer.byteLength(message) > 1024 * 1024) {
        fail(new Error("Repository write request exceeds size limit"));
        return;
      }
      socket.write(message);
    });
    socket.on("data", (chunk: Buffer) => {
      if (completed) return;
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        fail(new Error("Repository write response exceeds size limit"));
        return;
      }
      buffer += decoder.write(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response: unknown = JSON.parse(buffer.slice(0, newline));
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Invalid response");
        const value = response as Record<string, unknown>;
        if (value.id !== requestId || typeof value.ok !== "boolean") throw new Error("Invalid response identity");
        if (value.ok !== true || !value.result || typeof value.result !== "object" || Array.isArray(value.result)) {
          throw new Error(typeof value.error === "string" ? value.error : "Repository write rejected");
        }
        const result = value.result as Record<string, unknown>;
        if (typeof result.ok !== "boolean" || typeof result.applied !== "boolean" ||
            typeof result.dry_run !== "boolean" || typeof result.file_path !== "string") {
          throw new Error("Malformed repository write result");
        }
        completed = true;
        socket.end();
        resolve(result as ReplaceInFileResult);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("end", () => {
      if (!completed) fail(new Error("Repository write socket closed before acknowledgement; outcome unknown"));
    });
  });
}
