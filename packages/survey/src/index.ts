/**
 * IFB market-survey application.
 *
 * Member/agent surface (signed invite tokens, see token.ts):
 *   GET  /api/schema           the round's questions + display rules (machine-readable)
 *   GET  /api/draft            the org's draft, pre-filled answers included
 *   PATCH /api/draft           { answers: {code: value}, actor?: "agent:<name>" }
 *   POST /api/submit           { by: "member:<email>" | "agent:<name>" }
 *   GET  /r/<round>?t=<token>  the human form (UI milestone)
 *
 * Ops surface (x-admin-key = SURVEY_ADMIN_KEY secret; used by staff tooling and the
 * Cloudflare OS gatekeeper later):
 *   POST /api/admin/invite     { round_id, org_id, org_name, email? } -> invite link
 *
 * Isolation: the org/round scope comes exclusively from the verified token
 * (db.ts is the single data-access module; see test/isolation.md).
 */

import * as db from "./db";

export * from "./gatekeeper";
import { mintToken, sha256Hex, verifyToken } from "./token";
import { handleMcp } from "./mcp";
import { agentPage, formPage } from "./ui";

export interface Env {
  DB: D1Database;
  SURVEY_TOKEN_SECRET?: string;
  SURVEY_ADMIN_KEY?: string;
  PUBLIC_BASE_URL?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 1), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Token from Authorization: Bearer or ?t=; returns verified auth or null. */
async function authenticate(request: Request, env: Env) {
  if (!env.SURVEY_TOKEN_SECRET) return null;
  const url = new URL(request.url);
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const token = bearer || url.searchParams.get("t") || "";
  if (!token) return null;
  const claims = await verifyToken(env.SURVEY_TOKEN_SECRET, token);
  if (!claims) return null;
  // The signed token must also correspond to a live invite (revocation support),
  // and the invite row itself must agree on org + round.
  const invite = await db.inviteForTokenHash(env.DB, await sha256Hex(token));
  if (!invite || invite.org_id !== claims.o || invite.round_id !== claims.r) return null;
  return db.authFromClaims(claims);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") {
      try {
        const row = await env.DB.prepare("SELECT count(*) AS n FROM survey_round")
          .first<{ n: number }>();
        return json({ ok: true, db: "up", rounds: row?.n ?? 0 });
      } catch (err) {
        return json({ ok: false, db: String(err).slice(0, 200) }, 500);
      }
    }

    // ---- ops: mint an invite ------------------------------------------------
    if (path === "/api/admin/invite" && request.method === "POST") {
      if (!env.SURVEY_ADMIN_KEY ||
          request.headers.get("x-admin-key") !== env.SURVEY_ADMIN_KEY) {
        return json({ error: "unauthorized" }, 401);
      }
      const body = await request.json().catch(() => null) as Record<string, string> | null;
      if (!body?.round_id || !body?.org_id || !body?.org_name) {
        return json({ error: "round_id, org_id, org_name required" }, 400);
      }
      if (!await db.roundMeta(env.DB, body.round_id)) {
        return json({ error: "unknown_round" }, 404);
      }
      const expires = new Date(Date.now() + 120 * 24 * 3600 * 1000); // a round's lifetime
      const token = await mintToken(env.SURVEY_TOKEN_SECRET!, {
        o: body.org_id, r: body.round_id, e: Math.floor(expires.getTime() / 1000),
      });
      await db.createInvite(env.DB, {
        roundId: body.round_id, orgId: body.org_id, orgName: body.org_name,
        email: body.email, tokenHash: await sha256Hex(token),
        expiresAt: expires.toISOString().replace("T", " ").slice(0, 19),
      });
      const base = env.PUBLIC_BASE_URL || url.origin;
      // The link IS the credential. Never emailed by this worker (no send path exists).
      return json({ ok: true, link: `${base}/r/${body.round_id}?t=${token}` });
    }

    // ---- MCP: the member-agent handoff (same token authority as the form) ---
    if (path === "/mcp") {
      if (request.method === "DELETE") return new Response(null, { status: 202 });
      if (request.method !== "POST") {
        return json({ hint: "MCP endpoint. POST JSON-RPC here; connect with: claude mcp add --transport http ifb-survey \"<this url including ?t=...>\"" }, 405);
      }
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: "invalid_or_expired_token" }, 401);
      return handleMcp(request, env.DB, auth);
    }

    // Plain-language brief for agents; carries no survey data, so it is public.
    if (path === "/api/agent-guide") {
      return new Response(AGENT_GUIDE, {
        headers: { "content-type": "text/markdown; charset=utf-8" } });
    }

    // ---- member/agent API ---------------------------------------------------
    if (path.startsWith("/api/")) {
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: "invalid_or_expired_token" }, 401);

      if (path === "/api/schema" && request.method === "GET") {
        const [meta, qs] = await Promise.all([
          db.roundMeta(env.DB, auth.roundId), db.questions(env.DB, auth.roundId),
        ]);
        return json({
          round: meta,
          questions: qs,
          how_to: {
            draft: "GET /api/draft (Authorization: Bearer <token>)",
            save: "PATCH /api/draft {answers:{<code>:<value>}, actor:'agent:<name>'}",
            submit: "POST /api/submit {by:'member:<email>'|'agent:<name>'}",
            note: "Answers with source 'prefilled' are carried over from the previous round: confirm or update them.",
          },
        });
      }

      if (path === "/api/draft" && request.method === "GET") {
        await db.markStarted(env.DB, auth);
        return json({ org: auth.orgId, round: auth.roundId, ...(await db.draft(env.DB, auth)) });
      }

      if (path === "/api/draft" && request.method === "PATCH") {
        const body = await request.json().catch(() => null) as
          { answers?: Record<string, unknown>; actor?: string } | null;
        if (!body?.answers || typeof body.answers !== "object") {
          return json({ error: "answers object required" }, 400);
        }
        const source = body.actor?.startsWith("agent") ? "agent" as const : "member" as const;
        const result = await db.patchDraft(env.DB, auth, body.answers, source);
        return "error" in result ? json(result, 409) : json({ ok: true, ...result });
      }

      if (path === "/api/submit" && request.method === "POST") {
        const body = await request.json().catch(() => ({})) as { by?: string };
        const result = await db.submit(env.DB, auth, body.by || "member:unattributed");
        return "error" in result ? json(result, 409) : json(result);
      }

      return json({ error: "not_found" }, 404);
    }

    // ---- agent handoff page -------------------------------------------------
    if (path.startsWith("/r/") && path.endsWith("/agent")) {
      const auth = await authenticate(request, env);
      if (!auth) {
        return new Response("This invite link is invalid or has expired. Contact IFB for a fresh link.",
          { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const token = url.searchParams.get("t") ?? "";
      const org = await db.orgName(env.DB, auth.orgId);
      return new Response(agentPage(url.origin, auth.roundId, token, org ?? auth.orgId),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // ---- human form ---------------------------------------------------------
    if (path.startsWith("/r/")) {
      const auth = await authenticate(request, env);
      if (!auth) {
        return new Response("This invite link is invalid or has expired. Contact IFB for a fresh link.",
          { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const [meta, org] = await Promise.all([
        db.roundMeta(env.DB, auth.roundId), db.orgName(env.DB, auth.orgId),
      ]);
      return new Response(
        formPage(org ?? auth.orgId, (meta as { label?: string })?.label ?? "Market survey"),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (path === "/") {
      return new Response(
        "IFB market survey. Access is by invitation: use the personal link from your invite email.",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;

const AGENT_GUIDE = `# IFB market survey: guide for agents

You are acting for ONE invited organisation. The invite token (Bearer token, or ?t= on
/mcp) scopes everything to that organisation and round; you cannot see or touch anyone
else's data.

## Endpoints
- MCP: POST /mcp?t=<token>  (tools: get_schema, get_draft, update_answers, submit_response)
- REST: GET /api/schema, GET /api/draft, PATCH /api/draft {"answers":{"<code>":<value>}},
  POST /api/submit {"by":"agent:<name>"} with Authorization: Bearer <token>.

## Semantics that matter
- Answers with source "prefilled" were carried over from the organisation's PREVIOUS
  submission (the survey runs every two years). Treat them as a starting point: confirm
  them against current figures or update them. Do not invent numbers; ask the member.
- Question codes come from the schema. Values: string (text/select), number (number),
  array of strings (multiselect). display_if rules say when a question applies.
- Saving is incremental; you can update answers across many calls or sessions.
- Submission is FINAL and locks the draft. Only submit after the member has explicitly
  approved; attribute yourself in submitted_by.

## Confidentiality
Per-organisation answers are confidential to IFB; only aggregates are ever published.
Do not paste the organisation's answers into public channels.
`;