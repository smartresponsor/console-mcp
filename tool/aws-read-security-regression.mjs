import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../src/tool/aws-read.ts", import.meta.url), "utf8");
const catalog = readFileSync(new URL("../policy/console-tool-catalog-read-infra.json", import.meta.url), "utf8");
const names = ["read_.aws.environment.status", "read_.aws.identity.inspect", "read_.aws.secret.metadata", "read_.aws.access.diagnostics"];
for (const name of names) {
  assert.ok(source.includes('server.registerTool("' + name + '"'), name + " must be registered");
  assert.ok(catalog.includes('"canonicalName":"' + name + '"'), name + " must be cataloged");
}
assert.doesNotMatch(source, /get-secret-value|GetSecretValue|secretstring|secretbinary|list-secrets/i);
assert.match(source, /\["sts", "get-caller-identity"\]/);
assert.match(source, /\["secretsmanager", "describe-secret", "--secret-id", secretId\(\)\]/);
assert.match(source, /timeout, maxBuffer: 16384/);
assert.match(source, /z\.object\(\{\}\)\.strict\(\)/);
assert.match(source, /return \{ ok: false, status \}/);
assert.doesNotMatch(source, /stderr:\s*|error:\s*message|message:\s*message/);
const { classifyAwsReadFailure, runAwsReadOperation } = await import("../dist/tool/aws-read.js");
for (const [message, expected] of [
  ["NoRegion: You must specify a region", "NO_REGION"],
  ["Unable to locate credentials", "NO_CREDENTIALS"],
  ["AccessDeniedException: sensitive access token=abc", "ACCESS_DENIED"],
  ["ResourceNotFoundException", "RESOURCE_NOT_FOUND"],
  ["spawn aws ENOENT", "AWS_CLI_UNAVAILABLE"],
  ["other secret token=abc", "AWS_REQUEST_FAILED"],
]) {
  const result = classifyAwsReadFailure(new Error(message));
  assert.equal(result.status, expected);
  assert.equal(JSON.stringify(result).includes("abc"), false);
}
const invocations = [];
const executor = async (command, args, options) => {
  invocations.push({ command, args, options });
  return { stdout: JSON.stringify({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/test" }) };
};
const identity = await runAwsReadOperation(["sts", "get-caller-identity"], executor);
assert.equal(identity.ok, true);
assert.equal(identity.data.Account, "123456789012");
assert.equal(invocations[0].command, "aws");
assert.deepEqual(invocations[0].args, ["sts", "get-caller-identity", "--output", "json", "--no-cli-pager"]);
assert.equal(invocations[0].options.timeout, 5000);
assert.equal(invocations[0].options.maxBuffer, 16384);
const rejected = await runAwsReadOperation(["sts", "get-caller-identity"], async () => { throw new Error("AccessDenied token=abc"); });
assert.deepEqual(rejected, { ok: false, status: "ACCESS_DENIED" });
console.log("AWS_READ_SECURITY_REGRESSION_PASS: fixed operations, strict empty inputs, bounded CLI, sanitized errors, no secret retrieval");
