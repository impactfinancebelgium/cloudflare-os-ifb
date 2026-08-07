/**
 * MCP endpoint: the member-agent handoff.
 *
 * A member (or their staff) points any MCP client at
 *   https://<survey-host>/mcp?t=<invite-token>
 * and the agent can read the questionnaire, read the pre-filled draft, update
 * answers, and submit. Same authority as the web form: the invite token, scoped to
 * one organisation and one round. In Claude Code:
 *
 *   claude mcp add --transport http ifb-survey "https://<survey-host>/mcp?t=<token>"
 *
 * Implementation: JSON-RPC 2.0 over streamable HTTP (single JSON responses; no SSE,
 * which MCP permits for stateless servers). Tools mirror the REST API one to one.
 */

import * as db from "./db";
import type { Auth } from "./db";

const PROTOCOL = "2025-06-18";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "get_schema",
    description:
      "The questionnaire: every question with code, section, type, options and " +
      "display_if visibility rules ({code, equals}: show only when that answer matches). " +
      "Question codes are the keys used by update_answers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_draft",
    description:
      "The organisation's current draft. Answers with source 'prefilled' were carried " +
      "over from the previous round and should be confirmed or updated, not trusted blindly.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "update_answers",
    description:
      "Save one or more answers to the draft. Keys are question codes from get_schema; " +
      "values match the question type (string for text/select, number for number, " +
      "array of strings for multiselect). Saving is incremental and repeatable.",
    inputSchema: {
      type: "object",
      properties: {
        answers: {
          type: "object",
          description: "Map of question code to answer value.",
        },
      },
      required: ["answers"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_response",
    description:
      "Finalise and submit the response to IFB. IRREVERSIBLE: the draft locks. Only call " +
      "after the human you work for has confirmed the draft is ready. Pass their " +
      "confirmation explicitly.",
    inputSchema: {
      type: "object",
      properties: {
        confirmed_by_human: {
          type: "boolean",
          description: "Must be true: the member has explicitly approved submission.",
        },
        submitted_by: {
          type: "string",
          description: "Attribution, e.g. 'agent:claude-code on behalf of jane@member.be'.",
        },
      },
      required: ["confirmed_by_human", "submitted_by"],
      additionalProperties: false,
    },
  },
] as const;

const rpcResult = (id: RpcRequest["id"], result: unknown) =>
  ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) =>
  ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const toolText = (value: unknown) =>
  ({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }] });

async function callTool(
  d1: D1Database, auth: Auth, name: string, args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_schema": {
      const [meta, qs] = await Promise.all([
        db.roundMeta(d1, auth.roundId), db.questions(d1, auth.roundId),
      ]);
      return toolText({ round: meta, questions: qs });
    }
    case "get_draft": {
      await db.markStarted(d1, auth);
      return toolText({ org: auth.orgId, round: auth.roundId, ...(await db.draft(d1, auth)) });
    }
    case "update_answers": {
      const answers = args.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
        return toolText({ error: "answers must be an object of {code: value}" });
      }
      const result = await db.patchDraft(d1, auth, answers as Record<string, unknown>, "agent");
      return toolText(result);
    }
    case "submit_response": {
      if (args.confirmed_by_human !== true) {
        return toolText({
          error: "not_submitted",
          reason: "Submission requires the member's explicit approval. Ask them, then pass confirmed_by_human: true.",
        });
      }
      const by = typeof args.submitted_by === "string" && args.submitted_by
        ? `agent:${args.submitted_by.replace(/^agent:/, "")}` : "agent:unattributed";
      return toolText(await db.submit(d1, auth, by));
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** Handle a POST /mcp request that has already passed token authentication. */
export async function handleMcp(
  request: Request, d1: D1Database, auth: Auth,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });

  let rpc: RpcRequest;
  try {
    rpc = await request.json() as RpcRequest;
  } catch {
    return json(rpcError(null, -32700, "parse error"), 400);
  }

  try {
    switch (rpc.method) {
      case "initialize":
        return json(rpcResult(rpc.id, {
          protocolVersion:
            typeof rpc.params?.protocolVersion === "string"
              ? rpc.params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "ifb-market-survey", version: "1.0.0" },
          instructions:
            "IFB market survey for one invited organisation. Flow: get_schema to " +
            "understand the questionnaire, get_draft for the pre-filled answers " +
            "(source 'prefilled' = carried over, confirm or update), update_answers " +
            "to save, submit_response only after explicit human approval.",
        }));
      case "notifications/initialized":
      case "notifications/cancelled":
        return new Response(null, { status: 202 });
      case "ping":
        return json(rpcResult(rpc.id, {}));
      case "tools/list":
        return json(rpcResult(rpc.id, { tools: TOOLS }));
      case "tools/call": {
        const name = String(rpc.params?.name ?? "");
        const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
        return json(rpcResult(rpc.id, await callTool(d1, auth, name, args)));
      }
      default:
        return json(rpcError(rpc.id, -32601, `method not found: ${rpc.method}`));
    }
  } catch (err) {
    return json(rpcError(rpc.id, -32603, String(err).slice(0, 300)));
  }
}
