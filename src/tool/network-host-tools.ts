import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";
import { inspectHostNetworkInterfaces, inspectLocalSerialPorts } from "./network-host-inventory.js";
import { inspectHostRoutes, inspectHostNeighbors } from "./network-passive-topology.js";
import { inspectSshCapability, inspectSshDevice } from "./network-ssh-scrapli.js";

/** Read-only host inspection executes in the current Console MCP node, never in ChatGPT cloud. */
export function registerNetworkHostTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  const readRegistration = buildConsoleToolRegistration(authConfig);
  server.registerTool("read_.network.host.interfaces", {
    description: "Inspect local network interfaces, addresses, carrier, link rate, drivers and error counters. No packets or state changes.",
    inputSchema: z.object({}).strict(),
    ...readRegistration,
  }, async () => textResult(await inspectHostNetworkInterfaces()));

  server.registerTool("read_.network.serial.inventory", {
    description: "Passive local serial inventory: Linux USB tty devices and Windows COM ports (USB/Bluetooth/legacy) without opening ports or changing device state.",
    inputSchema: z.object({}).strict(),
    ...readRegistration,
  }, async () => textResult(await inspectLocalSerialPorts()));

  server.registerTool("read_.network.host.routes", {
    description: "Passive local Linux IPv4 routing-table snapshot from /proc/net/route; no packets, probes, DNS or mutations.",
    inputSchema: z.object({}).strict(),
    ...readRegistration,
  }, async () => textResult(await inspectHostRoutes()));

  server.registerTool("read_.network.host.neighbors", {
    description: "Passive local Linux kernel ARP cache snapshot from /proc/net/arp, not active device discovery or scanning.",
    inputSchema: z.object({}).strict(),
    ...readRegistration,
  }, async () => textResult(await inspectHostNeighbors()));

  server.registerTool("read_.network.ssh.capability", {
    description: "Read-only capability check for administrator-provisioned Scrapli SSH diagnostics; never discloses credentials or target inventory.",
    inputSchema: z.object({}).strict(),
    ...readRegistration,
  }, async () => textResult(await inspectSshCapability()));

  server.registerTool("read_.network.ssh.inspect", {
    description: "Authorized read-only SSH diagnostics of an administrator-allowlisted target ID; observation is strictly version/interfaces/neighbors. No arbitrary commands, addresses, credentials or configuration access.",
    inputSchema: z.object({
      targetId: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
      observation: z.enum(["version", "interfaces", "neighbors"]),
    }).strict(),
    ...readRegistration,
  }, async ({ targetId, observation }) => textResult(await inspectSshDevice(targetId, observation)));
}
