// Port of supabase/functions/resend-webhook (repos/ifb-db): reverse sync
// Resend -> Supabase. Unsubscribes/complaints/deletions in Resend flip
// newsletter_subscribed off in `contacts` so the push sync never re-adds them.
// Auth: Svix signature (see svix.ts) against RESEND_WEBHOOK_SECRET.

import { json, sbHeaders, type Env } from "./env.js";
import { verifySvix } from "./svix.js";

async function unsubscribe(env: Env, email?: string): Promise<void> {
  const em = (email ?? "").toLowerCase().trim();
  if (!em) return;
  await fetch(`${env.SUPABASE_URL}/rest/v1/contacts?email=eq.${encodeURIComponent(em)}`, {
    method: "PATCH",
    headers: { ...sbHeaders(env), Prefer: "return=minimal" },
    body: JSON.stringify({ newsletter_subscribed: false, subscribed: false }),
  });
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
