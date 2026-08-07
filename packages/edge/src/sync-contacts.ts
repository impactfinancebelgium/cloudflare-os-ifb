// Twenty -> Resend newsletter sync (backlog item 6, replacing the original
// Supabase-sourced port): the cohort is every Twenty person with
// newsletterSubscribed = true and an email, pushed into the Resend "General"
// audience. Only opted-in people are ever pushed (EU consent). Idempotent;
// "already exists" (409/422) is a skip. After the push, `subscribed` (the
// display-only "Resend state" field) is set true on cohort people found in the
// audience. Auth to Twenty: the ifb-os-twenty Access service token + API key,
// both Worker secrets. Auth to this route: x-sync-key must equal SYNC_SECRET.
// `?dry_run=1` reports the plan without writing.

import { json, type Env } from "./env.js";

type TwentyPerson = {
  id: string;
  name?: { firstName?: string; lastName?: string };
  emails?: { primaryEmail?: string };
  subscribed?: boolean;
};

function twentyHeaders(env: Env): Record<string, string> {
  return {
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID ?? "",
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET ?? "",
    authorization: `Bearer ${env.TWENTY_API_KEY ?? ""}`,
    "content-type": "application/json",
    "user-agent": "ifb-os-edge",
  };
}

const reHeaders = (env: Env) => ({
  authorization: `Bearer ${env.RESEND_API_KEY}`,
  "content-type": "application/json",
});

// Twenty caps page size at 60; paginate with pageInfo.endCursor (record-id
// pagination silently caps out, the known gotcha from the migration).
async function fetchCohort(env: Env): Promise<TwentyPerson[]> {
  const out: TwentyPerson[] = [];
  const filter = encodeURIComponent("newsletterSubscribed[eq]:true");
  let cursor = "";
  for (;;) {
    const after = cursor ? `&starting_after=${encodeURIComponent(cursor)}` : "";
    const res = await fetch(
      `${env.TWENTY_BASE_URL}/rest/people?limit=60&filter=${filter}${after}`,
      { headers: twentyHeaders(env), signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) throw new Error(`Twenty cohort fetch failed (${res.status})`);
    const body = (await res.json()) as {
      data?: { people?: TwentyPerson[] };
      pageInfo?: { hasNextPage?: boolean; endCursor?: string };
    };
    const rows = body.data?.people ?? [];
    out.push(...rows.filter((p) => p.emails?.primaryEmail));
    if (!body.pageInfo?.hasNextPage || !body.pageInfo.endCursor) break;
    cursor = body.pageInfo.endCursor;
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
  const cohortByEmail = new Map(
    cohort.map((p) => [p.emails!.primaryEmail!.toLowerCase(), p]),
  );
  const existing = await audienceEmails(env);
  const toCreate = [...cohortByEmail.entries()].filter(([em]) => !existing.has(em));

  let created = 0;
  let marked = 0;
  const failures: Array<{ email: string; code: number }> = [];
  if (!dryRun) {
    for (const [em, p] of toCreate) {
      const body: Record<string, unknown> = { email: em, unsubscribed: false };
      if (p.name?.firstName) body.first_name = p.name.firstName;
      if (p.name?.lastName) body.last_name = p.name.lastName;
      const r = await fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
        method: "POST",
        headers: reHeaders(env),
        body: JSON.stringify(body),
      });
      if (r.ok) created++;
      else if (r.status !== 409 && r.status !== 422) failures.push({ email: em, code: r.status });
    }

    // Crash-safe write-back: mark `subscribed` on cohort people now in the audience.
    const after = await audienceEmails(env);
    for (const [em, p] of cohortByEmail) {
      if (!after.has(em) || p.subscribed === true) continue;
      const r = await fetch(`${env.TWENTY_BASE_URL}/rest/people/${encodeURIComponent(p.id)}`, {
        method: "PATCH",
        headers: twentyHeaders(env),
        body: JSON.stringify({ subscribed: true }),
      });
      if (r.ok) marked++;
    }
  }

  return json({
    source: "twenty",
    dryRun,
    cohort: cohortByEmail.size,
    audience: existing.size,
    toCreate: toCreate.length,
    created,
    markedSubscribed: marked,
    failures: failures.length,
    sampleFailures: failures.slice(0, 5),
  });
}
