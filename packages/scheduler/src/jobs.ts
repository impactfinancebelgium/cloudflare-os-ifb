// IFB scheduled jobs. This table IS the schedule: jobs live in git, reviewed like any
// other change, and the deploy ships them. Keep `cron` values present in
// wrangler.jsonc `triggers.crons`, or the trigger never fires.
//
// Guardrails: jobs must be idempotent and safe to fire twice. Nothing here may send
// email, mutate a live system, or call a host outside ALLOWED_HOSTS. A job that needs
// a secret names it in `secretHeader`; the value comes from a Worker secret installed
// at deploy time (never from git).

export type JobAction = {
  // GET/POST a URL. The only action type in v1; service-binding and agent-trigger
  // actions come later with the Gatekeeper work.
  type: "fetch";
  url: string;
  method?: "GET" | "POST";
  body?: string;
  // Optional header sourced from a Worker secret: [headerName, secretBindingName].
  secretHeader?: [string, string];
  // HTTP statuses considered success (default: 2xx). Access-gated endpoints answer 302.
  okStatuses?: number[];
};

export type Job = {
  id: string;
  description: string;
  cron: string;
  enabled: boolean;
  action: JobAction;
};

export const ALLOWED_HOSTS = new Set([
  "os.impactfinance.be",
  "crm.impactfinance.be",
  "new.impactfinance.be",
  "drive.impactfinance.be",
  "api.resend.com",
  "ifb-os-edge.impact-finance-belgium.workers.dev",
]);

export const JOBS: Job[] = [
  {
    id: "heartbeat-os",
    description: "Hourly liveness check of the Cloudflare OS front door (expects the Access 302).",
    cron: "0 * * * *",
    enabled: true,
    action: { type: "fetch", url: "https://os.impactfinance.be/", okStatuses: [302] },
  },
  {
    id: "heartbeat-crm",
    description: "Hourly liveness check of Twenty CRM behind Access.",
    cron: "0 * * * *",
    enabled: true,
    action: { type: "fetch", url: "https://crm.impactfinance.be/", okStatuses: [302] },
  },
  // Replaces the Supabase pg_cron + Edge Function newsletter sync (cutover approved
  // by Jonas 2026-08-08). The edge worker reads the cohort from Twenty CRM (the human
  // source of truth) and pushes it to Resend.
  {
    id: "resend-contact-sync",
    description: "Hourly Twenty -> Resend newsletter contact sync.",
    cron: "0 * * * *",
    enabled: true,
    action: {
      type: "fetch",
      url: "https://ifb-os-edge.impact-finance-belgium.workers.dev/sync-contacts-to-resend",
      method: "POST",
      secretHeader: ["x-sync-key", "SYNC_SECRET"],
    },
  },
];
