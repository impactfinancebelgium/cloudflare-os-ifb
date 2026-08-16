// IFB recruitment mini app. A self-contained Worker over D1 (`ifb-recruitment`) + R2
// (`ifb-applications`, the existing CV bucket). Two audiences on one worker:
//   - PUBLIC intake: POST /submit-application  (the website careers form posts here)
//   - STAFF review:  /review + /api/*          (gated by ADMIN_KEY now; Cloudflare Access at cutover)
// Moves recruiting out of the Twenty custom-object module. Screening (Gemini) writes to D1.
// Design + rules: workflows/internship-recruiting.md in ifb-workspace.

import { reviewPage } from "./ui.js";
import { screenApplication } from "./screening.js";

export interface Env {
  DB: D1Database;
  CVS: R2Bucket;
  ADMIN_KEY?: string;
  SCREEN_TOKEN?: string;
  GOOGLE_API_KEY?: string;
  RESEND_API_KEY?: string;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_FILE = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const LANGS = new Set(["fluent", "knowledge", "none"]);
const STAGES = new Set(["applied", "cv_screen", "interview_1", "interview_2", "decision"]);
const STATUSES = new Set(["in_review", "advanced", "shortlisted", "offered", "hired", "rejected", "withdrawn"]);
const SCORES = new Set(["good", "maybe", "not_good"]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, PATCH, OPTIONS",
  "access-control-allow-headers": "content-type, x-admin-key",
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

const pick = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");
const lang = (v: FormDataEntryValue | null) => {
  const s = pick(v).toLowerCase();
  return LANGS.has(s) ? s : null;
};
const isAdmin = (req: Request, env: Env) =>
  !!env.ADMIN_KEY && req.headers.get("x-admin-key") === env.ADMIN_KEY;

// ── public intake ──────────────────────────────────────────────────────────────
async function submitApplication(req: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected a multipart form submission." }, 400, CORS);
  }
  // honeypot: bots fill the hidden "company" field
  if (pick(form.get("company"))) return json({ ok: true }, 200, CORS);

  const firstName = pick(form.get("first_name"));
  const lastName = pick(form.get("last_name"));
  const email = pick(form.get("email")).toLowerCase();
  const position = pick(form.get("position")) || "an open position";
  if (!firstName || !email) return json({ error: "First name and email are required." }, 400, CORS);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "That email looks invalid." }, 400, CORS);
  if (!form.get("consent")) return json({ error: "Please confirm the consent checkbox." }, 400, CORS);

  // store CV + optional cover letter in R2
  const store = async (file: File, kind: string): Promise<string> => {
    if (file.size > MAX_FILE_BYTES) throw new Error(`The ${kind} must be under 5 MB.`);
    if (file.type && !ALLOWED_FILE.includes(file.type)) throw new Error(`The ${kind} must be a PDF or Word document.`);
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const key = `applications/${new Date().getFullYear()}/${crypto.randomUUID()}-${safe}`;
    await env.CVS.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });
    return key;
  };
  let cvKey: string | null = null;
  let coverKey: string | null = null;
  try {
    const cv = form.get("cv");
    const cover = form.get("cover_letter");
    if (cv instanceof File && cv.size > 0) cvKey = await store(cv, "CV");
    if (cover instanceof File && cover.size > 0) coverKey = await store(cover, "cover letter");
  } catch (err) {
    return json({ error: (err as Error).message }, 400, CORS);
  }

  const mandatory = pick(form.get("mandatory"));
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO recruitment_application
        (id, position_applied, source, first_name, last_name, email, cv_key, cover_letter_key,
         motivation_text, start_month, months_available, full_or_part_time, university, study_level,
         mandatory_for_studies, country_residence, nationality, lang_en, lang_fr, lang_nl,
         stage, status)
       VALUES (?1,?2,'website_form',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,'applied','in_review')`,
    )
      .bind(
        id, position, firstName, lastName || null, email, cvKey, coverKey,
        pick(form.get("motivation")).slice(0, 4000) || null,
        pick(form.get("start_month")) || null,
        pick(form.get("months_available")) || null,
        pick(form.get("full_or_part_time")) || null,
        pick(form.get("university")) || null,
        pick(form.get("study_level")) || null,
        mandatory === "yes" ? 1 : mandatory === "no" ? 0 : null,
        pick(form.get("country_residence")) || null,
        pick(form.get("nationality")) || null,
        lang(form.get("lang_en")), lang(form.get("lang_fr")), lang(form.get("lang_nl")),
      )
      .run();
  } catch (err) {
    console.error("intake: D1 insert failed", err);
    return json({ error: "We could not record your application. Please email hello@impactfinance.be." }, 502, CORS);
  }

  // applicant acknowledgement (never block the application on mail)
  if (env.RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: "Impact Finance Belgium <hello@impactfinance.be>",
          to: [email],
          bcc: ["hello@impactfinance.be"],
          subject: `We received your application: ${position}`,
          text: `Dear ${firstName},\n\nThank you for applying for ${position} at Impact Finance Belgium. `
            + `We have received your application and will come back to you.\n\nKind regards,\nImpact Finance Belgium`,
        }),
      });
    } catch (err) {
      console.error("intake: acknowledgement failed", err);
    }
  }
  return json({ ok: true }, 200, CORS);
}

// ── staff review API ─────────────────────────────────────────────────────────
async function listCandidates(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM recruitment_application ORDER BY applied_at DESC`,
  ).all();
  return json({ count: results.length, candidates: results });
}

const EDITABLE = ["stage", "status", "score", "score_comment", "decision", "notes",
  "start_fit", "full_or_part_time", "finance_experience", "impact_experience",
  "lang_en", "lang_fr", "lang_nl", "country_residence", "nationality"];

async function updateCandidate(req: Request, env: Env, id: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE.includes(k)) continue;
    if (k === "stage" && v != null && !STAGES.has(String(v))) return json({ error: "bad stage" }, 400);
    if (k === "status" && v != null && !STATUSES.has(String(v))) return json({ error: "bad status" }, 400);
    if (k === "score" && v != null && !SCORES.has(String(v))) return json({ error: "bad score" }, 400);
    sets.push(`${k} = ?`);
    vals.push(v === "" ? null : v);
  }
  if (!sets.length) return json({ error: "nothing to update" }, 400);
  sets.push(`updated_at = datetime('now')`);
  vals.push(id);
  const info = await env.DB.prepare(
    `UPDATE recruitment_application SET ${sets.join(", ")} WHERE id = ?`,
  ).bind(...vals).run();
  return json({ ok: true, changed: info.meta.changes });
}

async function serveCv(env: Env, id: string, which: "cv" | "cover"): Promise<Response> {
  const col = which === "cv" ? "cv_key" : "cover_letter_key";
  const row = await env.DB.prepare(`SELECT ${col} AS k, first_name, last_name FROM recruitment_application WHERE id = ?`)
    .bind(id).first<{ k: string | null; first_name: string; last_name: string }>();
  if (!row?.k) return new Response("Not found", { status: 404 });
  const obj = await env.CVS.get(row.k);
  if (!obj) return new Response("File missing", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "content-disposition": `inline; filename="${which}-${row.last_name || row.first_name || id}"`,
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    if (method === "OPTIONS") return new Response(null, { headers: CORS });

    // public intake
    if (pathname === "/submit-application" && method === "POST") return submitApplication(req, env);

    // screening (called by the Twenty workflow today, by our own trigger after cutover)
    if (pathname === "/api/screen" && method === "POST") {
      if (!env.SCREEN_TOKEN || req.headers.get("x-screen-token") !== env.SCREEN_TOKEN) {
        return json({ error: "forbidden" }, 403);
      }
      const { id } = (await req.json().catch(() => ({}))) as { id?: string };
      if (!id) return json({ error: "id required" }, 400);
      return screenApplication(env, id);
    }

    // staff review UI (gated by ADMIN_KEY via the page's key prompt; Cloudflare Access at cutover)
    if ((pathname === "/" || pathname === "/review") && method === "GET") {
      return new Response(reviewPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // staff API (ADMIN_KEY)
    if (pathname.startsWith("/api/") || pathname.startsWith("/cv/") || pathname.startsWith("/cover/")) {
      // header for API calls; query key for file links opened in a new tab
      const keyOk = isAdmin(req, env) || (!!env.ADMIN_KEY && url.searchParams.get("k") === env.ADMIN_KEY);
      if (!keyOk) return json({ error: "forbidden" }, 403);
      if (pathname === "/api/candidates" && method === "GET") return listCandidates(env);
      const m = pathname.match(/^\/api\/candidates\/([0-9a-f-]{36})$/i);
      if (m && method === "PATCH") return updateCandidate(req, env, m[1]);
      const cv = pathname.match(/^\/cv\/([0-9a-f-]{36})$/i);
      if (cv && method === "GET") return serveCv(env, cv[1], "cv");
      const cover = pathname.match(/^\/cover\/([0-9a-f-]{36})$/i);
      if (cover && method === "GET") return serveCv(env, cover[1], "cover");
    }

    return json({ error: "not found" }, 404);
  },
};
