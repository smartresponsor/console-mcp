import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import crypto from "node:crypto";
import { normalizePath } from "./policy.js";
import type { AllowedCheck } from "./policy.js";

const execFileAsync = promisify(execFile);

export type CommandTranscript = {
  checkName: string;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

export type CommandResult = CommandTranscript & {
  transcriptPath: string;
};

export async function runNamedCheck(baseDir: string, checkName: string, workspacePath: string, check: AllowedCheck): Promise<CommandResult> {
  const cwd = normalizePath(workspacePath);
  const startedAt = new Date();
  const started = startedAt.getTime();
  const timeout = check.timeoutMs;

  const env = buildSafeEnv();
  const command = check.command;
  const args = check.args;

  const transcriptDir = path.join(baseDir, "var", "transcript");
  await mkdir(transcriptDir, { recursive: true });

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env,
    });

    return await writeTranscript(transcriptDir, {
      checkName,
      command,
      args,
      cwd,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      exitCode: 0,
      signal: null,
      stdout: sanitizeText(stdout),
      stderr: sanitizeText(stderr),
    });
  } catch (error) {
    const captured = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string | null; code?: number | null };
    const stdout = sanitizeText(String(captured.stdout ?? ""));
    const stderr = sanitizeText(String(captured.stderr ?? captured.message ?? error));
    return await writeTranscript(transcriptDir, {
      checkName,
      command,
      args,
      cwd,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      exitCode: typeof captured.code === "number" ? captured.code : null,
      signal: captured.signal ?? null,
      stdout,
      stderr,
    });
  }
}

export function sanitizeText(text: string): string {
  const secretValues = collectSecretValues();
  let redacted = String(text);
  for (const value of secretValues) {
    if (value.length >= 4) {
      redacted = redacted.split(value).join("[redacted]");
    }
  }
  return redacted;
}

function collectSecretValues(): string[] {
  const names = Object.keys(process.env).filter((name) => /TOKEN|SECRET|KEY|PASSWORD|PRIVATE/i.test(name));
  return names
    .map((name) => process.env[name])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function buildSafeEnv(): Record<string, string> {
  const cwd = normalizePath(process.cwd());
  return {
    PATH: process.env.PATH ?? "",
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
    ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? cwd,
    USERPROFILE: process.env.USERPROFILE ?? cwd,
    TEMP: process.env.TEMP ?? path.join(cwd, "tmp"),
    TMP: process.env.TMP ?? path.join(cwd, "tmp"),
    APPDATA: process.env.APPDATA ?? path.join(cwd, "AppData", "Roaming"),
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? path.join(cwd, "AppData", "Local"),
    ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files",
    "ProgramFiles(x86)": process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  };
}

async function writeTranscript(transcriptDir: string, transcript: CommandTranscript): Promise<CommandResult> {
  const fileStem = `${transcript.startedAt.replace(/[:.]/g, "-")}-${transcript.checkName}-${crypto.randomBytes(4).toString("hex")}`;
  const transcriptPath = path.join(transcriptDir, `${fileStem}.json`);
  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  return {
    ...transcript,
    transcriptPath,
  };
}
