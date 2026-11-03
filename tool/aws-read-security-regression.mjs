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
console.log("AWS_READ_SECURITY_REGRESSION_PASS: fixed operations, strict empty inputs, bounded CLI, sanitized errors, no secret retrieval");
