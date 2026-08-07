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
import { mintToken, sha256Hex, verifyToken } from "./token";

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

    // ---- human form (full UI in a later milestone) --------------------------
    if (path.startsWith("/r/")) {
      const auth = await authenticate(request, env);
      if (!auth) {
        return new Response("This invite link is invalid or has expired. Contact IFB for a fresh link.",
          { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return new Response(
        `Invite verified for your organisation. The form UI ships in the next milestone; agents can already use /api/schema, /api/draft, /api/submit with this link's token.`,
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (path === "/") {
      return new Response(
        "IFB market survey. Access is by invitation: use the personal link from your invite email.",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
