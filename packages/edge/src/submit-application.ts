// Port of supabase/functions/submit-application (repos/ifb-db): public intake for
// the recruiting application form. Multipart form in; CV to the private
// applicant-cvs bucket; contact upsert; recruitment_applications row; Resend
// acknowledgement (bcc hello@). Uses raw PostgREST + Storage REST instead of
// supabase-js so the Worker stays dependency-free.

import { json, sbHeaders, type Env } from "./env.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
};
const cjson = (obj: unknown, status = 200) => json(obj, status, cors);
const lang = (v: unknown) => (["fluent", "knowledge", "none"].includes(String(v)) ? String(v) : null);

async function sbSelectOne(env: Env, path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders(env) });
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function sbInsert(env: Env, table: string, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=id`, {
    method: "POST",
    headers: { ...sbHeaders(env), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const rows = (await res.json()) as Array<Record<string, unknown>> | { message?: string };
  if (!res.ok || !Array.isArray(rows) || !rows.length) {
    throw new Error((rows as { message?: string })?.message ?? `insert into ${table} failed (${res.status})`);
  }
  return rows[0];
}

export async function submitApplication(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return cjson({ error: "Method not allowed" }, 405);

  try {
    const form = await req.formData();

    // Honeypot: bots fill hidden fields. Pretend success, store nothing.
    if (String(form.get("company") || "").trim()) return cjson({ ok: true });

    const email = String(form.get("email") || "").trim().toLowerCase();
    const firstName = String(form.get("first_name") || "").trim();
    const lastName = String(form.get("last_name") || "").trim();
    const position = String(form.get("position") || "").trim() || "an open position";
    if (!email || !firstName) return cjson({ error: "Please provide your name and email." }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return cjson({ error: "Please provide a valid email." }, 400);
    if (String(form.get("consent")) !== "yes") return cjson({ error: "Please confirm the consent checkbox." }, 400);

    // Upsert the person into contacts (candidate = a contact).
    const existing = await sbSelectOne(env, `contacts?select=id&email=eq.${encodeURIComponent(email)}`);
    let contactId = existing?.id as string | undefined;
    if (!contactId) {
      const ins = await sbInsert(env, "contacts", {
        email,
        first_name: firstName,
        last_name: lastName || null,
        full_name: `${firstName} ${lastName}`.trim(),
        relationship_with_ifb: "Candidate",
        source: "website_careers_form",
        subscribed: false,
      });
      contactId = ins.id as string;
    }

    // Upload the CV to the private bucket via the Storage REST API.
    let cvPath: string | null = null;
    // workers-types types FormData entries as string; multipart file parts are Files
    // at runtime, so go through unknown for the narrowing.
    const cv = form.get("cv") as unknown;
    if (cv instanceof File && cv.size > 0) {
      const ext = (cv.name.split(".").pop() || "pdf").toLowerCase();
      cvPath = `applications/${contactId}/${Date.now()}-cv.${ext}`;
      const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/applicant-cvs/${cvPath}`, {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": cv.type || "application/pdf",
        },
        body: cv.stream(),
      });
      if (!up.ok) throw new Error(`CV upload failed (${up.status})`);
    }

    // Insert the application (the structured screening fields the form collects).
    const mandatory = form.get("mandatory");
    const app = await sbInsert(env, "recruitment_applications", {
      contact_id: contactId,
      source: "website_form",
      position_applied: position,
      cv_path: cvPath,
      motivation_text: String(form.get("motivation") || "") || null,
      start_month: String(form.get("start_month") || "") || null,
      university: String(form.get("university") || "") || null,
      study_level: String(form.get("study_level") || "") || null,
      mandatory_for_studies: mandatory === "yes" ? true : mandatory === "no" ? false : null,
      full_or_part_time: String(form.get("full_or_part_time") || "") || null,
      months_available: String(form.get("months_available") || "") || null,
      country_residence: String(form.get("country_residence") || "") || null,
      nationality: String(form.get("nationality") || "") || null,
      lang_fr: lang(form.get("lang_fr")),
      lang_nl: lang(form.get("lang_nl")),
      lang_en: lang(form.get("lang_en")),
    });

    // Acknowledge to the applicant, bcc the team (transactional, applicant-initiated).
    if (env.RESEND_API_KEY) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: "Impact Finance Belgium <hello@impactfinance.be>",
          to: [email],
          bcc: ["hello@impactfinance.be"],
          reply_to: "hello@impactfinance.be",
          subject: "We received your application",
          text:
            `Hi ${firstName},\n\n` +
            `Thank you for applying for ${position} at Impact Finance Belgium. ` +
            `We have received your application and review applications on a rolling basis. ` +
            `If you are shortlisted, we will contact you to arrange an interview.\n\n` +
            `Best regards,\nImpact Finance Belgium`,
        }),
      }).catch(() => {});
    }

    return cjson({ ok: true, id: app.id });
  } catch (e) {
    return cjson({ error: (e as Error)?.message || "Something went wrong." }, 500);
  }
}
