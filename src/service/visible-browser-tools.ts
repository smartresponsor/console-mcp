import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { backgroundReadDecision } from "./background-read-policy.js";
import { inspectIsolatedBackground } from "./isolated-background-session.js";
import { inspectGrantsTarget, isGrantsAllowedUrl } from "./grants-browser-session.js";
import { getMcpRequestContext } from "../Infrastructure/Diagnostics/RequestContext.js";
import { inspectVisibleTarget, selectVisibleTarget, sameVisibleRuntime, type VisibleSessionEvidence, type VisibleSessionResult } from "./visible-browser-session.js";

const backgroundWebTools = new Set(["read_.web.page.capture", "read_.web.page.capture.dom", "read_.web.page.capture.form", "read_.web.form.inspect", "read_.web.form.extract", "read_.web.page.wait", "read_.web.chatgpt.snapshot"]);
const diagnosticWebTools = new Set(["read_.web.browser.status", "read_.web.browser.inventory", "read_.web.browser.targets", "read_.web.capability.contract"]);
export function requiresVisibleBrowser(name: string, input: Record<string, unknown>): boolean {
  // Artifact ingestion is a guarded filesystem operation, not a browser interaction.
  if (name === "write.web.artifact.import") return false;
  if (name.startsWith("write.browser.")) return true;
  if (/^(write|read_)\.web\./.test(name)) return !diagnosticWebTools.has(name);
  // Recovery must remain callable when the current page is a login form or
  // the visible-browser verifier itself is unhealthy. Command allowlists and
  // watchdog-owned safety checks enforce the recovery boundary separately.
  if (name === "write.dev.console.command.run") {
    const command = String(input.command ?? "");
    if (command === "watchdog-heal" || command === "desktop-heal-plan") return false;
    return /ensure|heal|start|refresh/.test(command);
  }
  return /^write\.engine\.(prompt\.(draft|submit|orphan)|reply\.|cycle\.|worker\.tick|chat\.bind)/.test(name) && !name.endsWith(".stop");
}
const visibleOperations = new Set<string>();
// Identity pins survive stateless server recreation, never visibility/approval decisions.
// No eviction can silently turn a stale pin back into unconstrained discovery.
const authenticatedBindings = new Map<string, VisibleSessionEvidence>();
const bindingLimit = 1024;
const record = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null ? v as Record<string, unknown> : {};
function blocked(session: VisibleSessionResult, mutationAttempted = false): unknown { return { content: [{ type: "text", text: JSON.stringify({ ...session, ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", visibility_verified: false, user_interaction_ready: false, states: session.states.filter(s => !["VISIBLE_TARGET_BOUND", "USER_INTERACTION_READY"].includes(s)), evidence: { ...session.evidence, verifiedAt: null }, mutation_attempted: mutationAttempted, outcome_unknown: mutationAttempted, automatic_retry_allowed: false }) }], isError: true }; }
export function enforceVisibleBrowserTools(server: McpServer, probes = { select: selectVisibleTarget, inspect: inspectVisibleTarget }): McpServer {
  const localBindings = new Map<string, VisibleSessionEvidence>();
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (name: string, config: unknown, handler: (...args: any[]) => Promise<any>) => {
        const guarded = async (...args: any[]) => {
          const input = record(args[0]);
          if (input.browserSession === "grants") {
            const allowed = new Set([
              "read_.web.browser.targets", "write.web.browser.bind", "write.web.target.open",
              "read_.web.page.capture", "read_.web.page.capture.dom", "read_.web.page.capture.form",
              "read_.web.page.wait", "read_.web.form.inspect", "read_.web.form.extract",
              "write.web.page.click", "write.web.form.proposal.preview", "write.web.form.fill",
              "write.web.form.upload", "write.web.form.review.snapshot", "write.web.form.submit"
            ]);
            const refuse = (reason: string) => ({
              content: [{ type: "text", text: JSON.stringify({
                ok: false, status: "WEB_GRANTS_SESSION_NOT_READY", reason,
                mutation_attempted: false, automatic_retry_allowed: false
              }) }], isError: true
            });
            if (!allowed.has(name)) return refuse("GRANTS_OPERATION_DENIED");
            if (name === "write.web.target.open" && !isGrantsAllowedUrl(String(input.url ?? "")))
              return refuse("GRANTS_HOST_NOT_ALLOWED");
            const id = typeof input.targetId === "string" ? input.targetId
              : typeof input.expectedTargetId === "string" ? input.expectedTargetId : undefined;
            const before = await inspectGrantsTarget({ proofLevel: "console", targetId: id,
              destinationUrl: name === "write.web.target.open" ? String(input.url ?? "") : undefined });
            if (!before.ok || !before.evidence) return refuse(before.reason);
            const lease = "grants:" + before.evidence.browserInstance;
            if (visibleOperations.has(lease)) return refuse("GRANTS_SESSION_BUSY");
            visibleOperations.add(lease);
            try {
              const response = await handler({ ...input, browserSession: "grants",
                ...(["write.web.browser.bind", "write.web.target.open"].includes(name)
                  ? { targetId: before.evidence.targetId } : {}) }, ...args.slice(1));
              const after = await inspectGrantsTarget({ proofLevel: "console",
                targetId: before.evidence.targetId, expected: before.evidence });
              for (const item of response.content ?? []) {
                if (item.type !== "text") continue;
                try {
                  const body = record(JSON.parse(item.text));
                  item.text = JSON.stringify({ ...body, grants_session: after,
                    ...(!after.ok ? { ok: false, status: "WEB_GRANTS_SESSION_CHANGED",
                      outcome_unknown: name.startsWith("write."), automatic_retry_allowed: false } : {}) });
                } catch { /* do not upgrade unparseable results */ }
              }
              if (!after.ok) response.isError = true;
              return response;
            } finally { visibleOperations.delete(lease); }
          }
          if (input.browserSession === "background") {
            const proof = await inspectIsolatedBackground(typeof input.targetId === "string" ? input.targetId : undefined);
            const decision = backgroundReadDecision({ tool: name, url: name === "write.web.job.open" ? String(input.url ?? "") : String(proof.targetUrl ?? ""), sessionKind: "dedicated-background", provisioned: proof.ok });
            const refuse = (reason: string) => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, status: "WEB_BACKGROUND_SESSION_NOT_READY", reason, mutation_attempted: false, automatic_retry_allowed: false }) }], isError: true });
            if (!decision.allowed) return refuse(proof.ok ? decision.reason : proof.reason);
            const lease = "background:" + proof.browserInstance;
            if (visibleOperations.has(lease)) return refuse("BACKGROUND_SESSION_BUSY");
            visibleOperations.add(lease);
            try {
              const response = await handler({ ...input, browserSession: "isolated" }, ...args.slice(1));
              const after = await inspectIsolatedBackground();
              if (!after.ok || after.browserInstance !== proof.browserInstance) {
                return { content: [{ type: "text", text: JSON.stringify({ ok: false, status: "WEB_BACKGROUND_SESSION_CHANGED", reason: after.reason, outcome_unknown: true, automatic_retry_allowed: false }) }], isError: true };
              }
              return response;
            } finally { visibleOperations.delete(lease); }
          }
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
          const ports = name.includes(".web.") && name !== "write.web.browser.open" ? [input.browserSession === "visible" || (!input.browserSession && (name === "read_.web.form.inspect" || name === "read_.web.page.capture" || name === "write.web.form.proposal.preview")) ? 9224 : Number(process.env.BROWSER_MCP_REMOTE_DEBUGGING_PORT || 9223)] : Array.isArray(input.ports) ? input.ports.filter((p): p is number => typeof p === "number") : [9222, 9223];
          const targetId = typeof input.targetId === "string" ? input.targetId : typeof input.expectedTargetId === "string" ? input.expectedTargetId : undefined;
          const background = input.browserSession === "visible" && backgroundWebTools.has(name);
          // Exact target binding must resolve the same CDP instance as inventory.
          // Probe both known Console-owned instances; never fall back from failed visibility evidence.
          const exactBind = (name === "write.web.browser.bind" || name === "write.web.page.click" || name === "write.web.form.proposal.preview" || name === "write.web.form.fill" || name === "write.web.form.review.snapshot" || name === "write.web.form.submit" || name === "write.web.target.open") && Boolean(targetId);
          // Read-only capture can resolve the sole actually visible target per request.
          // Never silently redirect mutations or ambiguous sessions.
          const discoverCapture = name === "read_.web.page.capture" && !targetId && !input.browserSession;
          const candidates = input.browserSession === "visible" ? [9224] : exactBind || discoverCapture ? [...new Set([Number(process.env.BROWSER_MCP_REMOTE_DEBUGGING_PORT || 9223), 9224])] : ports;
          const scope = getMcpRequestContext()?.browserBindingScope;
          const bindings = scope ? authenticatedBindings : localBindings;
          const key = (port: number) => `${scope ?? "local"}:${port}`;
          const bindingPorts = input.browserSession ? ports : [9224, Number(process.env.BROWSER_MCP_REMOTE_DEBUGGING_PORT || 9223)];
          const pins = name.includes(".web.") && name !== "write.web.browser.bind" && name !== "write.web.browser.open"
            ? [...new Set(bindingPorts)].map(port => bindings.get(key(port))).filter((pin): pin is VisibleSessionEvidence => Boolean(pin) && (!targetId || pin?.targetId === targetId)) : [];
          if (pins.length > 1) return blocked({ ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", reason: "AMBIGUOUS_VISIBLE_SESSIONS",
            evidence: pins[0], resolution_candidates: pins.map(evidence => ({ reason: "BOUND_SESSION", evidence })), states: [], correlationId, page_authentication_observation: "NOT_CHECKED", visibility_verified: false, user_interaction_ready: false });
          const pin = pins[0];
          const inspected: VisibleSessionResult[] = [];
          if (pin) {
            const candidate = await probes.inspect({ port: Number(new URL(pin.endpoint).port), targetId: pin.targetId ?? undefined, expected: pin, correlationId, background });
            // Keep the exact window identity as well as the process/instance pin. A tab moved
            // to another native window needs an explicit rebind, never an implicit redirect.
            if (candidate.ok && (!sameVisibleRuntime(pin, candidate.evidence) || candidate.evidence.targetId !== pin.targetId ||
                (candidate.evidence.cdpWindowId !== pin.cdpWindowId || (!background && candidate.evidence.windowId !== pin.windowId)))) {
              return blocked({ ...candidate, ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", reason: "VISIBLE_TARGET_IDENTITY_CHANGED", visibility_verified: false, user_interaction_ready: false });
            }
            if (!candidate.ok) return blocked(candidate);
            inspected.push(candidate);
          }
          for (const port of pin ? [] : candidates) {
            const candidate = await probes.select([port], targetId, correlationId, background);
            inspected.push(candidate);
            if (!exactBind && !discoverCapture) break;
          }
          const valid = inspected.filter(candidate => candidate.ok);
          if (!pin && (exactBind || discoverCapture) && valid.length !== 1) {
            if (valid.length > 1) return blocked({ ...valid[0], reason: "AMBIGUOUS_VISIBLE_SESSIONS",
              resolution_candidates: valid.map(({ reason, evidence }) => ({ reason, evidence })) });
            const matched = inspected.find(candidate => candidate.reason !== "BROWSER_TARGET_STALE" && candidate.reason !== "SESSION_UNAVAILABLE");
            return blocked(matched ?? inspected[0]);
          }
          const before = exactBind || discoverCapture ? valid[0] ?? inspected[0] : inspected[0];
          const bindingKey = key(Number(new URL(before.evidence.endpoint).port));
          if (name === "write.web.browser.bind" && !bindings.has(bindingKey) && bindings.size >= bindingLimit)
            return blocked({ ...before, ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", reason: "VISIBLE_BINDING_CAPACITY_REACHED", visibility_verified: false, user_interaction_ready: false });
          if (!before.ok) return blocked(before);
          const lease = `${before.evidence.endpoint}:${before.evidence.browserInstance}`;
          if (visibleOperations.has(lease)) return blocked({ ...before, ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", reason: "VISIBLE_SESSION_BUSY", visibility_verified: false, user_interaction_ready: false });
          visibleOperations.add(lease);
          try {
            // Constrain downstream selection to the verified endpoint and target; do not allow port fallback.
            const port = Number(new URL(before.evidence.endpoint).port);
            const constrained = { ...input };
            if (pin || discoverCapture || (!input.browserSession && (name === "read_.web.form.inspect" || name === "write.web.form.proposal.preview")) || (exactBind && (name.startsWith("write.web.form.") || name === "write.web.target.open"))) {
              constrained.browserSession = port === 9224 ? "visible" : "isolated";
              constrained.targetId = before.evidence.targetId;
            }
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
                bindings.delete(bindingKey);
                item.text = JSON.stringify({ ...body, closed_session: before.evidence,
                  visibility_verified: false, user_interaction_ready: false, automatic_retry_allowed: false });
                continue;
              }
              const created = record(body.target);
              const afterId = typeof created.id === "string" ? created.id : typeof body.targetId === "string" ? body.targetId : before.evidence.targetId ?? undefined;
              const observed = await probes.inspect({ port, targetId: afterId, expected: before.evidence, correlationId, background });
              const changed = pin && observed.ok && (!sameVisibleRuntime(pin, observed.evidence) || observed.evidence.targetId !== pin.targetId ||
                (observed.evidence.cdpWindowId !== pin.cdpWindowId || (!background && observed.evidence.windowId !== pin.windowId)));
              const after = changed ? { ...observed, ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", reason: "VISIBLE_TARGET_IDENTITY_CHANGED",
                states: observed.states.filter(state => !["VISIBLE_TARGET_BOUND", "USER_INTERACTION_READY"].includes(state)),
                evidence: { ...observed.evidence, verifiedAt: null }, visibility_verified: false, user_interaction_ready: false } : observed;
              item.text = JSON.stringify({ ...body, ...(after.ok ? {} : { ok: false, status: "WEB_VISIBLE_SESSION_REQUIRED", outcome_unknown: true, automatic_retry_allowed: false }), visible_session: after, browser_telemetry: { correlation_id: correlationId, cdp_success: after.states.includes("CDP_CONNECTED"), operation_success: body.ok === true, navigation_success: /\.(open|navigate)$/.test(name) ? body.navigation_success ?? null : null, target_binding_success: after.ok, visibility_verification_success: after.visibility_verified, user_interaction_ready: after.user_interaction_ready } });
              if (!after.ok) response.isError = true;
              // Only a successful explicit bind establishes/replaces an identity pin.
              if (name === "write.web.browser.bind" && body.ok === true && after.ok)
                bindings.set(bindingKey, { ...after.evidence });
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
