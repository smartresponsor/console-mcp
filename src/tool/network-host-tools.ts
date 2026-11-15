import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";
import { inspectHostNetworkInterfaces, inspectLocalSerialPorts } from "./network-host-inventory.js";

/** Read-only host inspection executes in the current Console MCP node, never in ChatGPT cloud. */
export function registerNetworkHostTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  const readRegistration = buildConsoleToolRegistration(authConfig);
  server.registerTool("read_.network.host.interfaces", {
    description: "Inspect local network interfaces, addresses, carrier, link rate, drivers and error counters. No packets or state changes.",
    inputSchema: z.object({}).strict(),
    ...readRegistration,
  }, async () => textResult(await inspectHostNetworkInterfaces()));

  server.registerTool("read_.network.serial.inventory", {
    description: "Enumerate locally attached Linux USB serial ports (/dev/ttyUSB*, /dev/ttyACM*) without opening or signaling a port.",
    inputSchema: z.object({}).strict(),
    ...readRegistration,
  }, async () => textResult(await inspectLocalSerialPorts()));
}
