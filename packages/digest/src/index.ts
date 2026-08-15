// ifb-digest: the team media digest. Collects, dedupes and shows what landed.
//
// Routes:
//   GET  /                the dashboard (Glance-style columns of sections)
//   GET  /admin/probe     per-source health, probed from the Worker
//   POST /admin/refresh   fetch every enabled source now
//   GET  /api/brief       JSON for the Hermes morning brief (bearer secret)
//
// Everything lives in one Durable Object (see store.ts), which also wakes itself
// hourly to fetch. There is no cron worker, no queue and no D1.

import { SECTIONS } from "./config.js";
import { DigestStore } from "./store.js";
import { renderDashboard, renderProbes } from "./dashboard.js";
import type { Item } from "./store.js";

export { DigestStore };

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 1), {
    status, headers: { "content-type": "application/json" },
  });

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    // One object, one stream. The name is fixed on purpose.
    const store = env.DIGEST.get(env.DIGEST.idFromName("ifb")) as unknown as DigestStore;
    await store.ensureSchedule();

    if (url.pathname === "/" || url.pathname === "") {
      const bySection = new Map<string, Item[]>();
      for (const section of SECTIONS) {
        bySection.set(section.id, await store.listSection(section.id, section.limit));
      }
      const stats = await store.stats();
      return html(renderDashboard({ bySection, stats, probes: await store.probes() }));
    }

    if (url.pathname === "/admin/probe") {
      return html(renderProbes(await store.probes()));
    }

    if (url.pathname === "/admin/refresh" && request.method === "POST") {
      return json({ sources: await store.refresh() });
    }

    // Applies the current config gates to history, so tightening a filter cleans up
    // what is already stored rather than only affecting the next fetch.
    if (url.pathname === "/admin/purge" && request.method === "POST") {
      return json({ removed: await store.purgeStale() });
    }

    // Read-only feed for the Hermes morning brief. Hermes runs on the IFB box and
    // holds the secret; nothing here writes.
    if (url.pathname === "/api/brief") {
      const secret = env.BRIEF_TOKEN;
      const auth = request.headers.get("authorization") ?? "";
      if (!secret || !timingSafeEqual(auth, `Bearer ${secret}`)) {
        return new Response("unauthorized", { status: 401 });
      }
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 8), 25);
      const items = await store.brief(limit);
      return json({
        generated: new Date().toISOString(),
        items: items.map((i) => ({
          title: i.title, url: i.url, outlet: i.outlet,
          section: i.section, lang: i.lang, sources: i.seen_count,
        })),
      });
    }

    return new Response("not found", { status: 404 });
  },
};
