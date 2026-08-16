// HqStore: a tiny Durable Object holding two things, both small.
//
//   1. The project board, pushed from the workspace on every git push. The repo
//      stays the source of truth; this is a cached projection of it, so the board
//      can never disagree with what is committed for long.
//   2. Cached liveness results for the app cards, so opening the page does not
//      fan out a dozen requests every time.

import { DurableObject } from "cloudflare:workers";

export interface Project {
  slug: string;
  title: string;
  /** Active, Paused, Done, Blocked: whatever the INDEX.md frontmatter says. */
  status: string;
  /** First meaningful line of the project note. */
  summary: string;
  owner: string;
  /** ISO date from the frontmatter, or the file's last change. */
  updated: string;
  openTasks: number;
}

export interface Health {
  id: string;
  ok: boolean;
  code: number;
  checked: number;
}

const HEALTH_TTL_MS = 5 * 60 * 1000;

export class HqStore extends DurableObject<Cloudflare.Env> {
  #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        updated TEXT NOT NULL DEFAULT '',
        open_tasks INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS health (
        id TEXT PRIMARY KEY,
        ok INTEGER NOT NULL,
        code INTEGER NOT NULL,
        checked INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /** Replace the whole board. The workspace push is authoritative, so this is a swap. */
  putProjects(projects: Project[]): number {
    this.#sql.exec("DELETE FROM projects");
    for (const p of projects) {
      this.#sql.exec(
        `INSERT INTO projects (slug, title, status, summary, owner, updated, open_tasks)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        p.slug, p.title, p.status ?? "", p.summary ?? "", p.owner ?? "",
        p.updated ?? "", p.openTasks ?? 0,
      );
    }
    this.#sql.exec(
      "INSERT INTO meta (key, value) VALUES ('projects_updated', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(Date.now()),
    );
    return projects.length;
  }

  projects(): { projects: Project[]; updated: number | null } {
    const rows = [...this.#sql.exec(
      "SELECT * FROM projects ORDER BY status, updated DESC, title",
    )];
    const meta = [...this.#sql.exec("SELECT value FROM meta WHERE key = 'projects_updated'")][0];
    return {
      projects: rows.map((r) => ({
        slug: r.slug as string, title: r.title as string, status: r.status as string,
        summary: r.summary as string, owner: r.owner as string,
        updated: r.updated as string, openTasks: r.open_tasks as number,
      })),
      updated: meta ? Number(meta.value) : null,
    };
  }

  /** Cached liveness. A 302 from an Access-gated app is healthy: the gate is working. */
  async health(targets: { id: string; url: string }[]): Promise<Health[]> {
    const now = Date.now();
    const cached = new Map<string, Health>();
    for (const row of this.#sql.exec("SELECT * FROM health")) {
      cached.set(row.id as string, {
        id: row.id as string, ok: Boolean(row.ok),
        code: row.code as number, checked: row.checked as number,
      });
    }

    const stale = targets.filter((t) => {
      const hit = cached.get(t.id);
      return !hit || now - hit.checked > HEALTH_TTL_MS;
    });

    await Promise.all(stale.map(async (target) => {
      let code = 0;
      try {
        const response = await fetch(target.url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(8_000),
        });
        code = response.status;
      } catch {
        code = 0;
      }
      // 2xx is up. 3xx means Cloudflare Access answered, which is also up.
      const ok = code >= 200 && code < 400;
      this.#sql.exec(
        `INSERT INTO health (id, ok, code, checked) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ok = excluded.ok, code = excluded.code, checked = excluded.checked`,
        target.id, ok ? 1 : 0, code, Date.now(),
      );
      cached.set(target.id, { id: target.id, ok, code, checked: Date.now() });
    }));

    return targets.map((t) => cached.get(t.id) ?? { id: t.id, ok: false, code: 0, checked: 0 });
  }
}
