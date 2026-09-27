import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";
import { executeAsk } from "./ask.js";

const jevQuestionSchema = z.object({
  type: z.enum(["noul", "choice", "score"]),
  instructions: z.string().min(1).max(4000),
  criteria: z.union([
    z.record(z.string()),
    z.array(z.string().min(1).max(1000)).max(100),
  ]).optional(),
}).strict();

export function registerJevEvaluateTool(
  server: McpServer,
  policy: ConsolePolicy,
  baseDir: string,
  authConfig: ConsoleAuthConfig,
): void {
  server.registerTool(
    "console.read_.ai.gateway.jev.evaluate",
    {
      description: "Evaluate bounded structured state with TypeSafe Jev through the existing AI Gateway/Vaulting route. Read-only; returns model evidence only and grants no execution authority.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        state: z.union([z.string().max(20000), z.record(z.unknown())]),
        questions: z.record(jevQuestionSchema).refine((value) => Object.keys(value).length > 0, "questions must not be empty"),
        timeoutMs: z.number().int().min(5000).max(60000).default(20000),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath, state, questions, timeoutMs }) => {
      const input = JSON.stringify({ state, questions });
      if (Buffer.byteLength(input, "utf8") > 24000) {
        return textResult({
          ok: false,
          status: "JEV_INPUT_TOO_LARGE",
          error: "Structured Jev input exceeds the bounded 24 KB Console MCP limit.",
        });
      }

      const result = await executeAsk(
        policy,
        baseDir,
        workspacePath,
        input,
        "typesafe/jev",
        256,
        0,
        timeoutMs,
        true,
        undefined,
      );

      return textResult({
        ok: result.ok && result.stdout_json_parse_ok,
        status: result.ok
          ? (result.stdout_json_parse_ok ? "JEV_EVALUATION_COMPLETED" : "JEV_RESPONSE_INVALID")
          : "JEV_EVALUATION_FAILED",
        model: "typesafe/jev",
        duration_ms: result.duration_ms,
        response: result.stdout_json,
        ...(result.ok ? {} : { error: result.stderr || "Jev evaluation failed." }),
        transcript_path: result.transcript_path,
      });
    },
  );

  server.registerTool(
    "console.read_.ai.gateway.jev.evaluate.batch",
    {
      description: "Evaluate up to 20 independent bounded states with TypeSafe Jev using one shared question contract. Read-only historical/shadow evaluation only; does not mutate Engine state.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        cases: z.array(z.object({
          id: z.string().min(1).max(200),
          state: z.union([z.string().max(20000), z.record(z.unknown())]),
        }).strict()).min(1).max(20),
        questions: z.record(jevQuestionSchema).refine((value) => Object.keys(value).length > 0, "questions must not be empty"),
        timeoutMs: z.number().int().min(5000).max(60000).default(20000),
        concurrency: z.number().int().min(1).max(4).default(2),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath, cases, questions, timeoutMs, concurrency }) => {
      const startedAt = Date.now();
      const results: Array<Record<string, unknown>> = [];

      const evaluateCase = async (item: { id: string; state: string | Record<string, unknown> }): Promise<Record<string, unknown>> => {
        const input = JSON.stringify({ state: item.state, questions });
        if (Buffer.byteLength(input, "utf8") > 24000) {
          return {
            id: item.id,
            ok: false,
            status: "JEV_INPUT_TOO_LARGE",
            error: "Structured Jev input exceeds the bounded 24 KB Console MCP limit.",
          };
        }

        const result = await executeAsk(
          policy,
          baseDir,
          workspacePath,
          input,
          "typesafe/jev",
          256,
          0,
          timeoutMs,
          true,
          undefined,
        );

        return {
          id: item.id,
          ok: result.ok && result.stdout_json_parse_ok,
          status: result.ok
            ? (result.stdout_json_parse_ok ? "JEV_EVALUATION_COMPLETED" : "JEV_RESPONSE_INVALID")
            : "JEV_EVALUATION_FAILED",
          model: "typesafe/jev",
          duration_ms: result.duration_ms,
          response: result.stdout_json,
          ...(result.ok ? {} : { error: result.stderr || "Jev evaluation failed." }),
          transcript_path: result.transcript_path,
        };
      };

      for (let index = 0; index < cases.length; index += concurrency) {
        const chunk = cases.slice(index, index + concurrency);
        results.push(...await Promise.all(chunk.map((item) => evaluateCase(item))));
      }

      const completed = results.filter((item) => item.ok === true).length;
      const failed = results.length - completed;
      const durations = results
        .map((item) => typeof item.duration_ms === "number" ? item.duration_ms : null)
        .filter((value): value is number => value !== null);

      return textResult({
        ok: failed === 0,
        status: failed === 0 ? "JEV_BATCH_COMPLETED" : "JEV_BATCH_PARTIAL_FAILURE",
        model: "typesafe/jev",
        case_count: cases.length,
        completed,
        failed,
        concurrency,
        wall_duration_ms: Date.now() - startedAt,
        wrapper_duration_ms_total: durations.reduce((sum, value) => sum + value, 0),
        results,
      });
    },
  );
}
