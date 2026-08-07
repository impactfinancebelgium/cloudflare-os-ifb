// ifb-os-edge: the three Supabase Edge Functions ported to one Cloudflare Worker,
// staged for the Supabase exit. Routes mirror the /functions/v1/<name> paths so the
// website's fetch calls only need a host swap at cutover.
//
// CUTOVER GATE: until the EDGE_ENABLED var/secret is "true", every route answers 503
// and nothing runs: no reads, no writes, no email. Flipping it (plus pointing the
// website + Resend webhook here) is Jonas's cutover decision, not a deploy side effect.

import { submitApplication } from "./submit-application.js";
import { resendWebhook } from "./resend-webhook.js";
import { syncContacts } from "./sync-contacts.js";
import type { Env } from "./env.js";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");

    if (path === "" || path === "/") {
      return new Response(
        `ifb-os-edge (staged: ${env.EDGE_ENABLED === "true" ? "ENABLED" : "disabled"})\n` +
          `routes: /sync-contacts-to-resend /resend-webhook /submit-application\n`,
        { headers: { "content-type": "text/plain" } },
      );
    }

    if (env.EDGE_ENABLED !== "true") {
      return new Response("staged: not cut over (EDGE_ENABLED != true)", { status: 503 });
    }

    switch (path) {
      case "/sync-contacts-to-resend":
        return syncContacts(req, env);
      case "/resend-webhook":
        return resendWebhook(req, env);
      case "/submit-application":
        return submitApplication(req, env);
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
