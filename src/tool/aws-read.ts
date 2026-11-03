import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const run = promisify(execFile);
const timeout = 5000;
type Result = { ok: boolean; status: string; data?: Record<string, unknown> };
export function classifyAwsReadFailure(error: unknown): Result {
  const message = String(error instanceof Error ? error.message : error);
  const status = /NoRegion|specify a region/i.test(message) ? "NO_REGION"
    : /Unable to locate credentials|NoCredentials/i.test(message) ? "NO_CREDENTIALS"
    : /AccessDenied|UnauthorizedOperation/i.test(message) ? "ACCESS_DENIED"
    : /ResourceNotFound/i.test(message) ? "RESOURCE_NOT_FOUND"
    : /ENOENT/i.test(message) ? "AWS_CLI_UNAVAILABLE"
    : /timed out|ETIMEDOUT/i.test(message) ? "TIMEOUT" : "AWS_REQUEST_FAILED";
  return { ok: false, status };
}
export async function runAwsReadOperation(args: string[], executor: typeof run = run): Promise<Result> {
  try {
    const { stdout } = await executor("aws", [...args, "--output", "json", "--no-cli-pager"], {
      timeout, maxBuffer: 16384, encoding: "utf8", windowsHide: true, env: { ...process.env, AWS_PAGER: "" },
    });
    return { ok: true, status: "OK", data: JSON.parse(stdout) as Record<string, unknown> };
  } catch (error) { return classifyAwsReadFailure(error); }
}
const secretId = () => process.env.CONSOLE_MCP_BEARER_SECRET_ID?.trim() || "/secret/dev/console-mcp/bearer-token";
export function registerAwsReadTools(server: McpServer, auth: ConsoleAuthConfig): void {
  const config = buildConsoleToolRegistration(auth);
  const inputSchema = z.object({}).strict();
  server.registerTool("read_.aws.environment.status", {
    description: "Check AWS region and profile configuration without exposing credentials.", inputSchema, ...config,
  }, async () => {
    const region = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim();
    const profile = process.env.AWS_PROFILE?.trim() || process.env.AWS_DEFAULT_PROFILE?.trim();
    let configRegion = false;
    if (!region) {
      try {
        const { stdout } = await run("aws", ["configure", "get", "region"], { timeout, maxBuffer: 1024, encoding: "utf8" });
        configRegion = Boolean(stdout.trim());
      } catch { /* Do not expose CLI errors. */ }
    }
    return textResult({ ok: true, status: "OK", region_configured: Boolean(region) || configRegion,
      region_source: region ? "environment" : configRegion ? "aws-config" : "missing",
      profile_configured: Boolean(profile), credentials_disclosed: false });
  });
  server.registerTool("read_.aws.identity.inspect", {
    description: "Read AWS caller identity via STS GetCallerIdentity.", inputSchema, ...config,
  }, async () => {
    const result = await runAwsReadOperation(["sts", "get-caller-identity"]);
    return textResult(!result.ok ? result : { ok: true, status: "OK",
      account: result.data?.Account, arn: result.data?.Arn, user_id: result.data?.UserId });
  });
  server.registerTool("read_.aws.secret.metadata", {
    description: "Describe configured bearer secret metadata only; never read its value.", inputSchema, ...config,
  }, async () => {
    const result = await runAwsReadOperation(["secretsmanager", "describe-secret", "--secret-id", secretId()]);
    return textResult(!result.ok ? result : { ok: true, status: "OK", exists: true,
      deleted: Boolean(result.data?.DeletedDate), rotation_enabled: Boolean(result.data?.RotationEnabled) });
  });
  server.registerTool("read_.aws.access.diagnostics", {
    description: "Classify STS and Secrets Manager metadata access without retrieving secret values.", inputSchema, ...config,
  }, async () => {
    const identity = await runAwsReadOperation(["sts", "get-caller-identity"]);
    if (!identity.ok) return textResult({ ok: false, status: identity.status, secret_metadata: "NOT_CHECKED" });
    const secret = await runAwsReadOperation(["secretsmanager", "describe-secret", "--secret-id", secretId()]);
    return textResult({ ok: secret.ok, status: secret.status, identity: "OK",
      secret_metadata: secret.status, secret_value_read: false });
  });
}
