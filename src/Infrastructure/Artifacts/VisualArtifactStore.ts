import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConsolePolicy } from "../../Policy/ConsolePolicy.js";
import { assertAllowedRoot, isWithinRoot } from "../../Policy/PathGuard.js";

export type VisualArtifactProducer = "localhost-inspect" | "playwright" | "panther" | "mobile-ui";
export type VisualArtifactPlatform = "web" | "android" | "ios";

export type VisualArtifactRunMetadata = {
  producer: VisualArtifactProducer;
  platform: VisualArtifactPlatform;
  cohort?: "new-user" | "existing-user" | "unspecified";
  scenario?: string;
  taskId?: string;
  runId?: string;
  capturedAt?: Date;
};

export type VisualArtifactRun = {
  artifactRoot: string;
  component: string;
  date: string;
  runId: string;
  runDir: string;
  screenshotsDir: string;
  logsDir: string;
  manifestPath: string;
  todayManifestPath: string;
};

export async function createVisualArtifactRun(
  policy: ConsolePolicy,
  workspacePath: string | null,
  metadata: VisualArtifactRunMetadata,
): Promise<VisualArtifactRun> {
  const capturedAt = metadata.capturedAt ?? new Date();
  const date = capturedAt.toISOString().slice(0, 10);
  const component = sanitizeArtifactSegment(workspacePath ? path.win32.basename(workspacePath) : "console-mcp");
  const runId = sanitizeArtifactSegment(metadata.runId ?? buildRunId(capturedAt, metadata.taskId));
  const artifactRoot = resolveVisualArtifactRoot(policy, workspacePath);
  const runDir = path.join(artifactRoot, component, date, runId);
  const screenshotsDir = path.join(runDir, "screenshots", metadata.platform, sanitizeArtifactSegment(metadata.cohort ?? "unspecified"));
  const logsDir = path.join(runDir, "logs");
  const todayDir = path.join(artifactRoot, component, "today");
  const manifestPath = path.join(runDir, "manifest.json");
  const todayManifestPath = path.join(todayDir, "manifest.json");

  await mkdir(screenshotsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await mkdir(todayDir, { recursive: true });

  const manifest = {
    schema: "visual-artifact-run-v1",
    component,
    date,
    run_id: runId,
    producer: metadata.producer,
    platform: metadata.platform,
    cohort: metadata.cohort ?? "unspecified",
    scenario: metadata.scenario ?? null,
    task_id: metadata.taskId ?? null,
    captured_at: capturedAt.toISOString(),
    screenshots_dir: path.relative(runDir, screenshotsDir).replaceAll("\\", "/"),
    logs_dir: path.relative(runDir, logsDir).replaceAll("\\", "/"),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(todayManifestPath, `${JSON.stringify({ date, run_id: runId, target: `../${date}/${runId}` }, null, 2)}\n`, "utf8");

  return {
    artifactRoot,
    component,
    date,
    runId,
    runDir,
    screenshotsDir,
    logsDir,
    manifestPath,
    todayManifestPath,
  };
}

export function resolveVisualArtifactRoot(policy: ConsolePolicy, workspacePath: string | null): string {
  if (!workspacePath) {
    return path.join(policy.transcriptDir, "var");
  }

  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const matchingRoots = policy.allowedRoots
    .filter((root) => isWithinRoot(workspace, root))
    .sort((left, right) => left.length - right.length);
  const sandboxRoot = matchingRoots[0] ?? workspace;
  return path.join(sandboxRoot, "var");
}

export function sanitizeArtifactSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "artifact";
}

function buildRunId(capturedAt: Date, taskId?: string): string {
  const time = capturedAt.toISOString().slice(11, 19).replaceAll(":", "-");
  return taskId ? `${time}_${taskId}` : `run-${time}`;
}
