import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const envExamplePath = resolve(root, "ops/ubuntu/config/console-mcp.env.example");
const envExample = readFileSync(envExamplePath, "utf8");

const required = [
  "CONSOLE_MCP_PORT=3333",
  "CONSOLE_MCP_PUBLIC_ORIGIN=https://console-mcp-ubuntu.smartresponsor.com",
  "CONSOLE_MCP_OAUTH_AUDIENCE=https://console-mcp-ubuntu.smartresponsor.com",
  "CONSOLE_MCP_BEARER_TOKEN=",
];

const forbidden = [
  "CONSOLE_MCP_PUBLIC_ORIGIN=https://console-mcp.smartresponsor.com",
  "CONSOLE_MCP_OAUTH_AUDIENCE=https://console-mcp.smartresponsor.com",
  "CONSOLE_MCP_PORT=3334",
];

const failures = [];

for (const line of required) {
  if (!envExample.includes(line)) {
    failures.push(`missing required Ubuntu staging line: ${line}`);
  }
}

for (const line of forbidden) {
  if (envExample.includes(line)) {
    failures.push(`Ubuntu staging example must not contain: ${line}`);
  }
}

if (!envExample.includes("Windows-to-Ubuntu migration")) {
  failures.push("Ubuntu env example must document the migration boundary.");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Ubuntu migration ingress regression passed.");
