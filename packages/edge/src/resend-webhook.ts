// Reverse sync, Resend -> Twenty CRM (backlog item 6): when someone unsubscribes,
// complains, or is deleted in Resend, flip newsletterSubscribed/subscribed off on
// the matching Twenty person so the push sync never re-adds them.
// Auth: Svix signature (see svix.ts) against RESEND_WEBHOOK_SECRET.

import { json, type Env } from "./env.js";
import { verifySvix } from "./svix.js";

function twentyHeaders(env: Env): Record<string, string> {
  return {
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID ?? "",
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET ?? "",
    authorization: `Bearer ${env.TWENTY_API_KEY ?? ""}`,
    "content-type": "application/json",
    "user-agent": "ifb-os-edge",
  };
}

async function unsubscribe(env: Env, email?: string): Promise<void> {
  const em = (email ?? "").toLowerCase().trim();
  if (!em) return;
  // ilike without wildcards = case-insensitive exact match (person emails are unique).
  const filter = encodeURIComponent(`emails.primaryEmail[ilike]:${em.replace(/[%(),:]/g, "")}`);
  const res = await fetch(`${env.TWENTY_BASE_URL}/rest/people?limit=2&filter=${filter}`, {
    headers: twentyHeaders(env),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Twenty lookup failed (${res.status})`);
  const body = (await res.json()) as { data?: { people?: Array<{ id: string }> } };
  for (const person of body.data?.people ?? []) {
    await fetch(`${env.TWENTY_BASE_URL}/rest/people/${encodeURIComponent(person.id)}`, {
      method: "PATCH",
      headers: twentyHeaders(env),
      body: JSON.stringify({ newsletterSubscribed: false, subscribed: false }),
    });
  }
}

export async function resendWebhook(req: Request, env: Env): Promise<Response> {
  const payload = await req.text();
  const ok = await verifySvix(env.RESEND_WEBHOOK_SECRET ?? "", payload, {
    id: req.headers.get("svix-id") ?? "",
    timestamp: req.headers.get("svix-timestamp") ?? "",
    signature: req.headers.get("svix-signature") ?? "",
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  let evt: { type?: string; data?: Record<string, unknown> };
  try {
    evt = JSON.parse(payload);
  } catch {
    return new Response("bad payload", { status: 400 });
  }
  const type = evt.type ?? "";
  const data = (evt.data ?? {}) as Record<string, unknown>;

  try {
    if (type === "contact.updated" && data.unsubscribed === true) {
      await unsubscribe(env, data.email as string | undefined);
    } else if (type === "contact.deleted") {
      await unsubscribe(env, data.email as string | undefined);
    } else if (type === "email.complained") {
      const to = data.to;
      const em = Array.isArray(to) ? (to[0] as string) : ((to ?? data.email) as string | undefined);
      await unsubscribe(env, em);
    }
    // Other event types are acknowledged but not acted on.
  } catch {
    return new Response("error", { status: 500 });
  }

  return json({ ok: true, handled: type });
}
