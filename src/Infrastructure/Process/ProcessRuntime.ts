import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import crypto from "node:crypto";
import { normalizePath } from "../../Policy/ConsolePolicy.js";
import type { AllowedCheck } from "../../Policy/ConsolePolicy.js";

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
  const command = resolveCommandExecutable(check.command);
  const args = check.args;
  const useShell = isWindowsCommandScript(command);
  const commandForExec = useShell && command.includes(" ") ? `"${command}"` : command;

  const transcriptDir = path.join(baseDir, "var", "transcript");
  await mkdir(transcriptDir, { recursive: true });

  try {
    const { stdout, stderr } = await execFileAsync(commandForExec, args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env,
      shell: useShell,
    });

    return await writeTranscript(transcriptDir, {
      checkName,
      command: commandForExec,
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

export function buildSafeEnv(): Record<string, string> {
  const cwd = normalizePath(process.cwd());
  const pathValue = process.env.PATH ?? process.env.Path ?? process.env.path ?? "";
  const env: Record<string, string> = {
    PATH: pathValue,
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
    ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? cwd,
    USERPROFILE: process.env.USERPROFILE ?? cwd,
    TEMP: process.env.TEMP ?? path.join(cwd, "tmp"),
    TMP: process.env.TMP ?? path.join(cwd, "tmp"),
    APPDATA: process.env.APPDATA ?? path.join(cwd, "AppData", "Roaming"),
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? path.join(cwd, "AppData", "Local"),
    ProgramData: process.env.ProgramData ?? "C:\\ProgramData",
    ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files",
    "ProgramFiles(x86)": process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  };

  for (const name of [
    "GIT_ASKPASS",
    "GIT_CONFIG_GLOBAL",
    "GIT_EXECUTABLE",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_SSH_VARIANT",
    "GPG_AGENT_INFO",
    "GPG_TTY",
    "GNUPGHOME",
    "PINENTRY_USER_DATA",
    "SSH_AGENT_PID",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
  ]) {
    copyOptionalEnv(env, name);
  }

  return env;
}

function copyOptionalEnv(env: Record<string, string>, name: string): void {
  const value = process.env[name];
  if (typeof value === "string" && value.trim() !== "") {
    env[name] = value;
  }
}

export function resolveCommandExecutable(command: string): string {
  const normalized = command.trim();
  if (hasPathSyntax(normalized)) {
    const directCandidates = collectCommandCandidates(normalized);
    for (const candidate of directCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return normalized;
  }

  const pathCandidates = collectPathCandidates(normalized);
  for (const candidate of pathCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const configuredCandidates = collectConfiguredExecutableCandidates(normalized);
  for (const candidate of configuredCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const directCandidates = collectCommandCandidates(normalized);
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return normalized;
}

function hasPathSyntax(command: string): boolean {
  return path.win32.isAbsolute(command) || command.includes("\\") || command.includes("/");
}

function collectCommandCandidates(command: string): string[] {
  if (hasPathSyntax(command)) {
    return [command];
  }

  const baseDir = normalizePath(process.cwd());
  const candidates = new Set<string>();
  const add = (candidate: string) => {
    candidates.add(candidate);
  };

  const commandLower = command.toLowerCase();
  if (commandLower === "git") {
    add("C:\\Program Files\\Git\\cmd\\git.exe");
    add("C:\\Program Files\\Git\\bin\\git.exe");
    add("C:\\Program Files (x86)\\Git\\cmd\\git.exe");
    add("C:\\Program Files (x86)\\Git\\bin\\git.exe");
    add(path.win32.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "cmd", "git.exe"));
    add(path.win32.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "git.exe"));
  } else if (commandLower === "npm") {
    add("C:\\Program Files\\nodejs\\npm.cmd");
    add("C:\\Program Files\\nodejs\\npm.ps1");
    add("C:\\Program Files\\nodejs\\npm.exe");
  } else if (commandLower === "composer") {
    add("C:\\ProgramData\\ComposerSetup\\bin\\composer.bat");
    add("C:\\ProgramData\\ComposerSetup\\bin\\composer.phar");
    add("C:\\ProgramData\\ComposerSetup\\bin\\composer");
  } else if (commandLower === "php") {
    add("C:\\Program Files\\PHP\\php.exe");
    add("C:\\php\\php.exe");
  }

  add(path.win32.join(baseDir, command));
  return Array.from(candidates);
}

function collectConfiguredExecutableCandidates(command: string): string[] {
  const commandLower = command.toLowerCase();
  const candidates = new Set<string>();
  const add = (value: string | undefined) => {
    const candidate = stripWrappingQuotes(value ?? "");
    if (candidate !== "") {
      candidates.add(candidate);
    }
  };

  if (commandLower === "git") {
    add(process.env.CONSOLE_MCP_GIT_EXECUTABLE);
    add(process.env.GIT_EXECUTABLE);
  }

  return Array.from(candidates);
}

function collectPathCandidates(command: string): string[] {
  const pathValue = process.env.PATH ?? process.env.Path ?? process.env.path ?? "";
  const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const directories = pathValue.split(";").map((item) => stripWrappingQuotes(item)).filter(Boolean);
  const candidates = new Set<string>();

  const hasExtension = Boolean(path.win32.extname(command));
  for (const directory of directories) {
    if (!hasExtension) {
      for (const ext of pathext) {
        candidates.add(path.win32.join(directory, `${command}${ext.toLowerCase()}`));
        candidates.add(path.win32.join(directory, `${command}${ext.toUpperCase()}`));
      }
    }

    candidates.add(path.win32.join(directory, command));
  }

  return Array.from(candidates);
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function isWindowsCommandScript(command: string): boolean {
  const extension = path.win32.extname(command).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
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

