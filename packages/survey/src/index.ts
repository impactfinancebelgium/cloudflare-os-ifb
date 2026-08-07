/**
 * IFB market-survey application (MVP).
 *
 * Member-facing over signed invite tokens; staff-facing through the Cloudflare OS
 * gatekeeper card (added in a later milestone). Design authority:
 * ifb-workspace/projects/market-survey/survey-app-proposal.md.
 *
 * Milestone 1: worker + D1 wired, health check proving the database binding.
 */

export interface Env {
  DB: D1Database;
  SURVEY_TOKEN_SECRET?: string;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      try {
        const row = await env.DB
          .prepare("SELECT count(*) AS rounds FROM survey_round")
          .first<{ rounds: number }>();
        return json({ ok: true, db: "up", rounds: row?.rounds ?? 0 });
      } catch (err) {
        return json({ ok: false, db: String(err).slice(0, 200) }, 500);
      }
    }

    if (url.pathname === "/") {
      return new Response(
        "IFB market survey. Access is by invitation: use the personal link from your invite email.",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
