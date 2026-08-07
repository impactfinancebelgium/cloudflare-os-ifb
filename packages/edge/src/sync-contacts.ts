// Port of supabase/functions/sync-contacts-to-resend (repos/ifb-db): push the
// newsletter opt-in cohort from Supabase `contacts` into the Resend "General"
// audience, then write resend_contact_id back. Idempotent; only opted-in contacts
// are ever pushed (EU consent). Auth: x-sync-key header must equal SYNC_SECRET.
// `?dry_run=1` reports the plan without writing.

import { json, sbHeaders, type Env } from "./env.js";

type Contact = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  resend_contact_id: string | null;
};

const reHeaders = (env: Env) => ({
  authorization: `Bearer ${env.RESEND_API_KEY}`,
  "content-type": "application/json",
});

async function fetchCohort(env: Env): Promise<Contact[]> {
  const out: Contact[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/contacts?select=email,first_name,last_name,resend_contact_id&newsletter_subscribed=is.true&email=not.is.null`,
      { headers: { ...sbHeaders(env), Range: `${from}-${from + page - 1}`, "Range-Unit": "items" } },
    );
    const rows = (await res.json()) as Contact[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

async function audienceEmails(env: Env): Promise<Map<string, string>> {
  const res = await fetch(
    `https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`,
    { headers: reHeaders(env) },
  );
  const body = (await res.json()) as { data?: Array<{ id: string; email?: string }> };
  const map = new Map<string, string>();
  for (const c of body?.data ?? []) {
    const em = (c.email ?? "").toLowerCase();
    if (em) map.set(em, c.id);
  }
  return map;
}

export async function syncContacts(req: Request, env: Env): Promise<Response> {
  if (!env.SYNC_SECRET || req.headers.get("x-sync-key") !== env.SYNC_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";

  const cohort = await fetchCohort(env);
  const cohortByEmail = new Map(cohort.map((c) => [c.email.toLowerCase(), c]));
  const existing = await audienceEmails(env);
  const toCreate = [...cohortByEmail.entries()].filter(([em]) => !existing.has(em));

  let created = 0;
  const failures: Array<{ email: string; code: number }> = [];
  if (!dryRun) {
    for (const [em, c] of toCreate) {
      const body: Record<string, unknown> = { email: em, unsubscribed: false };
      if (c.first_name) body.first_name = c.first_name;
      if (c.last_name) body.last_name = c.last_name;
      const r = await fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
        method: "POST",
        headers: reHeaders(env),
        body: JSON.stringify(body),
      });
      if (r.ok) created++;
      else if (r.status !== 409 && r.status !== 422) failures.push({ email: em, code: r.status });
    }

    // Crash-safe write-back: map resend_contact_id for every cohort email now in the audience.
    const after = await audienceEmails(env);
    for (const [em, cid] of after) {
      if (!cohortByEmail.has(em)) continue;
      await fetch(`${env.SUPABASE_URL}/rest/v1/contacts?email=eq.${encodeURIComponent(em)}`, {
        method: "PATCH",
        headers: { ...sbHeaders(env), Prefer: "return=minimal" },
        body: JSON.stringify({ resend_contact_id: cid, subscribed: true }),
      });
    }
  }

  return json({
    dryRun,
    cohort: cohortByEmail.size,
    audience: existing.size,
    toCreate: toCreate.length,
    created,
    failures: failures.length,
    sampleFailures: failures.slice(0, 5),
  });
}
