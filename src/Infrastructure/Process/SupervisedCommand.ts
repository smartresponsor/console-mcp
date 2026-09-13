import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { buildSafeEnv, resolveCommandInvocation, sanitizeText } from "./ProcessRuntime.js";

const execFileAsync = promisify(execFile);

export type SupervisedCommandResult = {
  ok: boolean;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function runSupervisedCommand(cwd: string, commandName: string, args: string[], timeoutMs = 30000, maxBuffer = 2 * 1024 * 1024): Promise<SupervisedCommandResult> {
  const resolvedCommand = resolveCommandInvocation(commandName, args);
  const commandForExec = resolvedCommand.command;
  const commandArgs = resolvedCommand.args;
  const useShell = resolvedCommand.shell;

  try {
    const result = await execFileAsync(commandForExec, commandArgs, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer,
      env: buildSafeEnv(),
      shell: useShell,
    });

    return {
      ok: true,
      command: commandForExec,
      args,
      cwd,
      exitCode: 0,
      stdout: sanitizeText(String(result.stdout ?? "")),
      stderr: sanitizeText(String(result.stderr ?? "")),
    };
  } catch (error) {
    const captured = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | null };
    return {
      ok: false,
      command: commandForExec,
      args,
      cwd,
      exitCode: typeof captured.code === "number" ? captured.code : null,
      stdout: sanitizeText(String(captured.stdout ?? "")),
      stderr: sanitizeText(String(captured.stderr ?? captured.message ?? error)),
    };
  }
}
export async function runValidatedGradleWrapper(cwd: string, wrapperName: string, args: string[], timeoutMs = 300000, maxBuffer = 4 * 1024 * 1024): Promise<SupervisedCommandResult> {
  const allowedArgs = new Set(["tasks\u0000--all\u0000--console=plain", "build\u0000--console=plain", "test\u0000--console=plain"]);
  if (!allowedArgs.has(args.join("\u0000"))) throw new Error("GRADLE_ARGUMENTS_NOT_ALLOWED");
  if (process.platform !== "win32") throw new Error("GRADLE_WINDOWS_WRAPPER_HOST_MISMATCH");

  const rootReal = realpathSync(cwd);
  const wrapperPath = path.resolve(cwd, wrapperName);
  if (path.basename(wrapperPath).toLowerCase() !== "gradlew.bat" || !existsSync(wrapperPath)) throw new Error("GRADLE_WRAPPER_NOT_FOUND_OR_INVALID");
  const wrapperReal = realpathSync(wrapperPath);
  const relativeWrapper = path.relative(rootReal, wrapperReal);
  if (relativeWrapper.startsWith("..") || path.isAbsolute(relativeWrapper)) throw new Error("GRADLE_WRAPPER_PATH_ESCAPE");

  const wrapperStat = statSync(wrapperReal);
  if (!wrapperStat.isFile() || wrapperStat.size <= 0 || wrapperStat.size > 16 * 1024) throw new Error("GRADLE_WRAPPER_BATCH_NONCANONICAL");
  const batch = readFileSync(wrapperReal, "utf8");
  const requiredMarkers = ["Gradle startup script for Windows", "set APP_HOME=%DIRNAME%", "set JAVA_EXE=java.exe", "-Dorg.gradle.appname=%APP_BASE_NAME%", "gradle\\wrapper\\gradle-wrapper.jar", "%*"];
  if (!requiredMarkers.every((marker) => batch.includes(marker))) throw new Error("GRADLE_WRAPPER_BATCH_NONCANONICAL");
  if (/\b(?:powershell|pwsh|curl|wget|certutil|bitsadmin|mshta|rundll32|schtasks|wmic|ftp|ssh|scp)\b/i.test(batch)) throw new Error("GRADLE_WRAPPER_BATCH_NONCANONICAL");

  const jarPath = path.join(cwd, "gradle", "wrapper", "gradle-wrapper.jar");
  const propertiesPath = path.join(cwd, "gradle", "wrapper", "gradle-wrapper.properties");
  for (const candidate of [jarPath, propertiesPath]) {
    if (!existsSync(candidate)) throw new Error("GRADLE_WRAPPER_CHAIN_INCOMPLETE");
    const real = realpathSync(candidate);
    const relative = path.relative(rootReal, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("GRADLE_WRAPPER_PATH_ESCAPE");
  }

  const properties = readFileSync(propertiesPath, "utf8");
  const distributionMatch = properties.match(/^distributionUrl=(.+)$/m);
  const distributionUrl = distributionMatch?.[1]?.replace(/\\:/g, ":") ?? "";
  if (!/^https:\/\/services\.gradle\.org\/distributions\/gradle-[A-Za-z0-9._+-]+-(?:bin|all)\.zip$/i.test(distributionUrl)) throw new Error("GRADLE_WRAPPER_PROPERTIES_INVALID");
  if (!/^validateDistributionUrl=true$/m.test(properties)) throw new Error("GRADLE_WRAPPER_PROPERTIES_INVALID");

  const trackedCheck = await runSupervisedCommand(rootReal, "git", ["ls-files", "--error-unmatch", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties"], 30000, 1024 * 1024);
  if (!trackedCheck.ok) throw new Error("GRADLE_WRAPPER_CHAIN_UNTRACKED");
  const gitCheck = await runSupervisedCommand(rootReal, "git", ["diff", "--quiet", "HEAD", "--", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties"], 30000, 1024 * 1024);
  if (!gitCheck.ok) throw new Error("GRADLE_WRAPPER_CHAIN_DIRTY_OR_UNTRUSTED");

  const env = buildSafeEnv();
  for (const key of ["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "JAVA_OPTS", "GRADLE_OPTS"]) delete env[key];
  const javaHome = typeof env.JAVA_HOME === "string" && env.JAVA_HOME.trim() ? env.JAVA_HOME.trim() : null;
  const javaFromHome = javaHome ? path.join(javaHome, "bin", "java.exe") : null;
  const javaExe = javaFromHome && existsSync(javaFromHome) ? javaFromHome : "java.exe";
  const commandArgs = ["-Dorg.gradle.appname=gradlew", "-jar", realpathSync(jarPath), ...args];
  try {
    const result = await execFileAsync(javaExe, commandArgs, { cwd: rootReal, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer, env, shell: false });
    return { ok: true, command: javaExe, args: commandArgs, cwd: rootReal, exitCode: 0, stdout: sanitizeText(String(result.stdout ?? "")), stderr: sanitizeText(String(result.stderr ?? "")) };
  } catch (error) {
    const captured = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | null };
    return { ok: false, command: javaExe, args: commandArgs, cwd: rootReal, exitCode: typeof captured.code === "number" ? captured.code : null, stdout: sanitizeText(String(captured.stdout ?? "")), stderr: sanitizeText(String(captured.stderr ?? captured.message ?? error)) };
  }
}

export function truncateOutput(text: string, maxBytes = 12000): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, truncated: false };
  }

  return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export function normalizeRepoPath(input: string): string {
  const normalized = String(input || "").trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error("Path must be a relative repository path.");
  }

  return normalized;
}


