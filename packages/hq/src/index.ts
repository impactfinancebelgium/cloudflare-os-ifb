// ifb-hq: the front door. For anyone who does not live in a terminal, this is
// the workspace: one page listing every application they can open, whether it is
// up, and where each project stands.
//
// Routes:
//   GET  /              the launcher + project board (behind Cloudflare Access)
//   POST /api/projects  replace the project board (bearer secret; called by the
//                       workspace pre-push hook, so git stays the source of truth)

import { APPS } from "./apps.js";
import { HqStore, type Project } from "./store.js";
import { renderHq } from "./render.js";

export { HqStore };

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
    const store = env.HQ.get(env.HQ.idFromName("ifb")) as unknown as HqStore;

    if (url.pathname === "/api/projects" && request.method === "POST") {
      const secret = env.HQ_TOKEN;
      const auth = request.headers.get("authorization") ?? "";
      if (!secret || !timingSafeEqual(auth, `Bearer ${secret}`)) {
        return new Response("unauthorized", { status: 401 });
      }
      let body: { projects?: Project[] };
      try {
        body = await request.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const count = await store.putProjects(body.projects ?? []);
      return Response.json({ stored: count });
    }

    if (url.pathname === "/" || url.pathname === "") {
      const targets = APPS.filter((a) => a.check).map((a) => ({ id: a.id, url: a.url }));
      const [health, board] = await Promise.all([
        store.health(targets),
        store.projects(),
      ]);
      return new Response(renderHq(health, board.projects, board.updated), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("not found", { status: 404 });
  },
};
