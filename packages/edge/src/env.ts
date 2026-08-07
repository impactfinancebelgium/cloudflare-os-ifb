// Bindings for the ifb-os-edge Worker. EDGE_ENABLED is the cutover gate: until it is
// set to "true" (a deliberate `wrangler secret put`/vars change by Jonas), every route
// answers 503 and the worker can have no side effects, so it is safe to deploy staged.
export type Env = {
  EDGE_ENABLED?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_AUDIENCE_ID?: string;
  RESEND_WEBHOOK_SECRET?: string;
  SYNC_SECRET?: string;
};

export const json = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

export function sbHeaders(env: Env): Record<string, string> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}
