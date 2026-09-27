import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeDiagnosticText } from "./RuntimeDiagnostics.js";

type RuntimeProcessProfile = {
  name: string;
  consumer: string;
  host: string;
  port: number;
  authMode: string;
};

type RuntimeProcessEventContext = {
  projectRoot: string;
  buildFingerprint: string;
  canonicalRegistryFingerprint: string;
  managedRuntimeToken: string | null;
  explicitAuthMode: string | null;
  endpoint: string;
  profiles: RuntimeProcessProfile[];
};

type RuntimeProcessEventRecord = {
  timestamp: string;
  event: string;
  pid: number;
  ppid: number;
  uptime_seconds: number;
  cwd: string;
  argv: string[];
  node: string;
  platform: string;
  release: string;
  arch: string;
  buildFingerprint: string;
  canonicalRegistryFingerprint: string;
  managedRuntimeToken: string | null;
  explicitAuthMode: string | null;
  endpoint: string;
  profiles: RuntimeProcessProfile[];
  detail?: Record<string, unknown>;
};

let installed = false;
let context: RuntimeProcessEventContext | null = null;
let logFilePath: string | null = null;
let rethrowingUnhandledRejection = false;

export function installRuntimeProcessEventLogging(input: RuntimeProcessEventContext): void {
  context = input;
  logFilePath = path.join(input.projectRoot, "var", "log", "console-mcp-runtime-events.ndjson");
  if (installed) {
    recordRuntimeProcessEventSync("runtime_event_logging_context_refreshed");
    return;
  }

  installed = true;
  recordRuntimeProcessEventSync("runtime_startup");

  process.on("warning", (warning) => {
    recordRuntimeProcessEventSync("process_warning", { warning: serializeError(warning) });
  });

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    recordRuntimeProcessEventSync("uncaught_exception", { origin, error: serializeError(error) });
  });

  process.on("unhandledRejection", (reason) => {
    recordRuntimeProcessEventSync("unhandled_rejection", { reason: serializeUnknown(reason) });
    if (rethrowingUnhandledRejection) {
      return;
    }

    rethrowingUnhandledRejection = true;
    setImmediate(() => {
      if (reason instanceof Error) {
        throw reason;
      }

      throw new Error(`Unhandled rejection: ${formatUnknown(reason)}`);
    });
  });

  process.on("rejectionHandled", () => {
    recordRuntimeProcessEventSync("rejection_handled_after_unhandled");
  });

  process.on("exit", (code) => {
    recordRuntimeProcessEventSync("process_exit", { code });
  });
}

export function recordRuntimeProcessEventSync(event: string, detail: Record<string, unknown> = {}): void {
  if (!context || !logFilePath) {
    return;
  }

  const record: RuntimeProcessEventRecord = {
    timestamp: new Date().toISOString(),
    event,
    pid: process.pid,
    ppid: process.ppid,
    uptime_seconds: Math.floor(process.uptime()),
    cwd: process.cwd(),
    argv: process.argv.map((item) => sanitizeDiagnosticText(item).slice(0, 1000)),
    node: process.version,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    buildFingerprint: context.buildFingerprint,
    canonicalRegistryFingerprint: context.canonicalRegistryFingerprint,
    managedRuntimeToken: context.managedRuntimeToken,
    explicitAuthMode: context.explicitAuthMode,
    endpoint: context.endpoint,
    profiles: context.profiles,
    ...(Object.keys(detail).length > 0 ? { detail: sanitizeRecord(detail) } : {}),
  };

  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`console-mcp failed to write runtime event log: ${sanitizeDiagnosticText(message)}`);
  }
}

function serializeError(error: Error): Record<string, unknown> {
  return {
    name: sanitizeDiagnosticText(error.name || "Error").slice(0, 200),
    message: sanitizeDiagnosticText(error.message).slice(0, 2000),
    stack: error.stack ? sanitizeDiagnosticText(error.stack).slice(0, 8000) : null,
  };
}

function serializeUnknown(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return serializeError(value);
  }

  return {
    type: typeof value,
    value: formatUnknown(value),
  };
}

function formatUnknown(value: unknown): string {
  try {
    return sanitizeDiagnosticText(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 2000);
  } catch {
    return sanitizeDiagnosticText(String(value)).slice(0, 2000);
  }
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, sanitizeValue(value)]));
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeDiagnosticText(value).slice(0, 4000);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value && typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>);
  }

  return value;
}
