// IFB scheduler: the job-scheduling capability Cloudflare OS does not ship. A plain
// Worker on Cron Triggers running the git-reviewed job table in jobs.ts. Results go to
// structured logs (Workers Observability picks them up); failures log at error level so
// they surface in the dashboard and any log-based alerting.

import { ALLOWED_HOSTS, JOBS, type Job } from "./jobs.js";

type Env = Record<string, string | undefined>;

const FETCH_TIMEOUT_MS = 30_000;

async function runJob(job: Job, env: Env): Promise<void> {
  const started = Date.now();
  const { action } = job;
  const host = new URL(action.url).hostname;
  if (!ALLOWED_HOSTS.has(host)) {
    // A job table edit added a host without updating the allowlist: refuse loudly.
    console.error(JSON.stringify({ job: job.id, outcome: "blocked-host", host }));
    return;
  }

  const headers: Record<string, string> = { "user-agent": "ifb-os-scheduler/1.0" };
  if (action.secretHeader) {
    const [headerName, bindingName] = action.secretHeader;
    const secret = env[bindingName];
    if (!secret) {
      console.error(JSON.stringify({ job: job.id, outcome: "missing-secret", binding: bindingName }));
      return;
    }
    headers[headerName] = secret.startsWith("Bearer ") ? secret : `Bearer ${secret}`;
  }

  try {
    const response = await fetch(action.url, {
      method: action.method ?? "GET",
      headers,
      body: action.body,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const ok = action.okStatuses
      ? action.okStatuses.includes(response.status)
      : response.ok;
    const line = JSON.stringify({
      job: job.id, outcome: ok ? "ok" : "unexpected-status",
      status: response.status, ms: Date.now() - started,
    });
    if (ok) console.log(line); else console.error(line);
  } catch (error) {
    console.error(JSON.stringify({
      job: job.id, outcome: "error", ms: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const due = JOBS.filter((job) => job.enabled && job.cron === controller.cron);
    if (!due.length) {
      console.warn(JSON.stringify({ outcome: "no-jobs-for-cron", cron: controller.cron }));
      return;
    }
    // Jobs run concurrently; each catches its own failures so one cannot starve the rest.
    ctx.waitUntil(Promise.all(due.map((job) => runJob(job, env))));
  },

  // Manual trigger for verification: `wrangler dev --test-scheduled` or the dashboard's
  // "Trigger scheduled event". Plain fetches get a terse status page, no secrets shown.
  async fetch(): Promise<Response> {
    const summary = JOBS.map((j) => `${j.enabled ? "on " : "off"}  ${j.cron}  ${j.id}`).join("\n");
    return new Response(`ifb-os-scheduler\n\n${summary}\n`, {
      headers: { "content-type": "text/plain" },
    });
  },
};
