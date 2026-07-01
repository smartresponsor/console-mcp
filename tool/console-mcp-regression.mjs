import { Client } from "../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

const endpoint = new URL(process.env.CONSOLE_MCP_ENDPOINT ?? "http://127.0.0.1:3333/mcp");
const token = process.env.CONSOLE_MCP_BEARER_TOKEN ?? "";
const vendoringWorkspace = process.env.CONSOLE_MCP_VEND_WORKSPACE ?? "";
const consoleMcpWorkspace = process.env.CONSOLE_MCP_WORKSPACE ?? "";
const fixturePath = process.env.CONSOLE_MCP_FIXTURE_PATH ?? "";
const falseGreenWorkspace = process.env.CONSOLE_MCP_FALSE_GREEN_WORKSPACE ?? "";
const outsidePath = process.env.CONSOLE_MCP_OUTSIDE_PATH ?? "";
const apiKeyPath = process.env.CONSOLE_MCP_APIKEY_PATH ?? "";

function parseToolPayload(result) {
  const text = result?.content?.[0]?.text ?? "";
  try {
    return { ok: true, value: JSON.parse(text), raw: text };
  } catch {
    return { ok: false, value: null, raw: text };
  }
}

async function callTool(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { thrown: null, result: parseToolPayload(result) };
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error), result: null };
  }
}

async function main() {
  if (!token) {
    throw new Error("CONSOLE_MCP_BEARER_TOKEN is required.");
  }

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  const client = new Client({ name: "console-mcp-regression", version: "1.0.0" });
  await client.connect(transport);

  const listTools = await client.listTools();
  const health = await callTool(client, "console.read_.system.console.health", {});
  const describe = await callTool(client, "console.describe", {});
  const workspaceStatus = await callTool(client, "console.workspace_status", { workspacePath: vendoringWorkspace });
  const readFile = await callTool(client, "console.read_file", { filePath: apiKeyPath });
  const runCheck = await callTool(client, "console.run_check", { workspacePath: vendoringWorkspace, checkName: "phpstan" });
  const rcDiagnose = await callTool(client, "console.read_.release.rc.diagnose", {
    workspacePath: vendoringWorkspace,
    component: "vendoring",
    target: "phpstan",
    dirtyPolicy: "allow_existing_readonly",
    validationProfile: "symfony_host",
    maxFiles: 500,
    maxIssues: 120,
  });
  const rcFalseGreen = await callTool(client, "console.read_.release.rc.full", {
    workspacePath: falseGreenWorkspace,
    dirtyPolicy: "allow_existing_readonly",
    validationProfile: "node_package",
    maxFiles: 80,
    maxIssues: 20,
  });
  const rcRepairGate = await callTool(client, "console.write.release.rc.repair", {
    workspacePath: falseGreenWorkspace,
    dirtyPolicy: "allow_existing_readonly",
    validationProfile: "node_package",
    repairLimit: 1,
    allowedPaths: ["package.json"],
  });
  const rcRepairApproved = await callTool(client, "console.write.release.rc.repair", {
    workspacePath: falseGreenWorkspace,
    dirtyPolicy: "allow_existing_readonly",
    validationProfile: "node_package",
    repairLimit: 1,
    allowedPaths: ["package.json"],
    repairApplyApproved: true,
    writeEvidence: true,
  });
  const replaceDryRun = await callTool(client, "console.replace_in_file", {
    workspacePath: consoleMcpWorkspace,
    filePath: fixturePath,
    search: "alpha",
    replace: "beta",
    dryRun: true,
    reason: "regression smoke dry run",
  });
  const replaceApply = await callTool(client, "console.replace_in_file", {
    workspacePath: consoleMcpWorkspace,
    filePath: fixturePath,
    search: "alpha",
    replace: "beta",
    dryRun: false,
    reason: "regression smoke apply",
  });
  const replaceOutside = await callTool(client, "console.replace_in_file", {
    workspacePath: consoleMcpWorkspace,
    filePath: outsidePath,
    search: "alpha",
    replace: "beta",
    dryRun: true,
    reason: "regression smoke outside-root rejection",
  });
  const phpLintChanged = await callTool(client, "console.php_lint_changed", {
    workspacePath: vendoringWorkspace,
    includeUntracked: true,
  });

  await transport.close();
  await client.close?.();

  return {
    list_tools: listTools.tools.map((tool) => tool.name).sort(),
    health: health.result?.value ?? null,
    describe: describe.result?.value ?? null,
    workspace_status: workspaceStatus.result?.value ?? null,
    read_file: readFile.result?.value ?? null,
    run_check: runCheck.result?.value ?? null,
    rc_diagnose: rcDiagnose.result?.value ?? null,
    rc_false_green: rcFalseGreen.result?.value ?? null,
    rc_repair_gate: rcRepairGate.result?.value ?? null,
    rc_repair_approved: rcRepairApproved.result?.value ?? null,
    replace_dry_run: replaceDryRun.result?.value ?? null,
    replace_apply: replaceApply.result?.value ?? null,
    replace_outside: replaceOutside.result?.value ?? null,
    php_lint_changed: phpLintChanged.result?.value ?? null,
    errors: {
      health: health.thrown,
      describe: describe.thrown,
      workspace_status: workspaceStatus.thrown,
      read_file: readFile.thrown,
      run_check: runCheck.thrown,
      rc_diagnose: rcDiagnose.thrown,
      rc_false_green: rcFalseGreen.thrown,
      rc_repair_gate: rcRepairGate.thrown,
      rc_repair_approved: rcRepairApproved.thrown,
      replace_dry_run: replaceDryRun.thrown,
      replace_apply: replaceApply.thrown,
      replace_outside: replaceOutside.thrown,
      php_lint_changed: phpLintChanged.thrown,
    },
  };
}

main()
  .then((summary) => {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
