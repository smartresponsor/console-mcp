import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { getMcpRequestContext } from "../Infrastructure/Diagnostics/RequestContext.js";
import { inspectVisibleTarget, selectVisibleTarget, type VisibleSessionResult } from "./visible-browser-session.js";

const diagnosticWebTools = new Set(["read_.web.browser.status", "read_.web.browser.inventory", "read_.web.browser.targets", "read_.web.capability.contract"]);
export function requiresVisibleBrowser(name: string, input: Record<string, unknown>): boolean {
  if (name.startsWith("write.browser.")) return true;
  if (/^(write|read_)\.web\./.test(name)) return !diagnosticWebTools.has(name);
  if (name === "write.dev.console.command.run") return /ensure|heal|start|refresh/.test(String(input.command ?? ""));
  return /^write\.engine\.(prompt\.(draft|submit|orphan)|reply\.|cycle\.|worker\.tick|chat\.bind)/.test(name) && !name.endsWith(".stop");
}
const visibleOperations = new Set<string>();
const record = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null ? v as Record<string, unknown> : {};
function blocked(session: VisibleSessionResult, mutationAttempted = false): unknown { return { content: [{ type: "text", text: JSON.stringify({ ...session, states: session.states.filter(s => !["VISIBLE_TARGET_BOUND", "USER_INTERACTION_READY"].includes(s)), evidence: { ...session.evidence, verifiedAt: null }, mutation_attempted: mutationAttempted, outcome_unknown: mutationAttempted, automatic_retry_allowed: false }) }], isError: true }; }
export function enforceVisibleBrowserTools(server: McpServer, probes = { select: selectVisibleTarget, inspect: inspectVisibleTarget }): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (name: string, config: unknown, handler: (...args: any[]) => Promise<any>) => {
        const guarded = async (...args: any[]) => {
          const input = record(args[0]);
          if (!requiresVisibleBrowser(name, input)) {
            const response = await handler(...args);
            if (/^read_\.(web\.browser|browser\.)/.test(name)) {
              for (const item of response.content ?? []) {
                if (item.type !== "text") continue;
                try { item.text = JSON.stringify({ ...record(JSON.parse(item.text)), visibility_verified: false, user_interaction_ready: false }); } catch { /* opaque diagnostics imply no visibility proof */ }
              }
            }
            return response;
          }
          const correlationId = getMcpRequestContext()?.correlationId ?? randomUUID();
          const ports = name.includes(".web.") && name !== "write.web.browser.open" ? [input.browserSession === "visible" ? 9224 : Number(process.env.BROWSER_MCP_REMOTE_DEBUGGING_PORT || 9223)] : Array.isArray(input.ports) ? input.ports.filter((p): p is number => typeof p === "number") : [9222, 9223];
          const targetId = typeof input.targetId === "string" ? input.targetId : typeof input.expectedTargetId === "string" ? input.expectedTargetId : undefined;
          const before = await probes.select(ports, targetId, correlationId);
          if (!before.ok) return blocked(before);
          const lease = `${before.evidence.endpoint}:${before.evidence.browserInstance}`;
          if (visibleOperations.has(lease)) return blocked({ ...before, ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", reason: "VISIBLE_SESSION_BUSY", visibility_verified: false, user_interaction_ready: false });
          visibleOperations.add(lease);
          try {
            // Constrain downstream selection to the verified endpoint and target; do not allow port fallback.
            const port = Number(new URL(before.evidence.endpoint).port);
            const constrained = { ...input };
            if ("ports" in input) constrained.ports = [port];
            if ("targetId" in input) constrained.targetId = before.evidence.targetId;
            const response = await handler(constrained, ...args.slice(1));
            let verifiedResult = false;
            for (const item of response.content ?? []) {
              if (item.type !== "text") continue;
              let body: Record<string, unknown>;
              try { body = record(JSON.parse(item.text)); } catch { continue; }
              verifiedResult = true;
              // A confirmed browser close intentionally invalidates its target and visibility.
              // Preserve only the exact instance's terminal result; all other outcomes keep the post-gate.
              if (name === "write.web.browser.close" && body.ok === true &&
                  body.status === "WEB_BROWSER_INSTANCE_CLOSED" && body.previous_pid === before.evidence.browserPid) {
                item.text = JSON.stringify({ ...body, closed_session: before.evidence,
                  visibility_verified: false, user_interaction_ready: false, automatic_retry_allowed: false });
                continue;
              }
              const created = record(body.target);
              const afterId = typeof created.id === "string" ? created.id : typeof body.targetId === "string" ? body.targetId : before.evidence.targetId ?? undefined;
              const after = await probes.inspect({ port, targetId: afterId, expected: before.evidence, correlationId });
              item.text = JSON.stringify({ ...body, ...(after.ok ? {} : { ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", outcome_unknown: true, automatic_retry_allowed: false }), visible_session: after, browser_telemetry: { correlation_id: correlationId, cdp_success: after.states.includes("CDP_CONNECTED"), operation_success: body.ok === true, navigation_success: /\.(open|navigate)$/.test(name) ? body.navigation_success ?? null : null, target_binding_success: after.ok, visibility_verification_success: after.visibility_verified, user_interaction_ready: after.user_interaction_ready } });
              if (!after.ok) response.isError = true;
            }
            if (!verifiedResult) return blocked({ ...before, ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", reason: "POST_OPERATION_VISIBILITY_UNKNOWN", visibility_verified: false, user_interaction_ready: false }, true);
            return response;
          } finally { visibleOperations.delete(lease); }
        };
        return (target.registerTool as any).call(target, name, config, guarded);
      };
    },
  });
}
