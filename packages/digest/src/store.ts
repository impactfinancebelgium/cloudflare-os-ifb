// DigestStore: the single Durable Object that holds every item, every source probe
// result, and the edition state. One stream, one writer, so dedup is atomic by
// construction and no two fetch cycles can race.
//
// The alarm drives everything: it wakes the object to fetch, and schedules the next
// wake. There is no cron worker, no queue and no workflow engine.

import { DurableObject } from "cloudflare:workers";
import {
  SOURCES, SECTIONS, googleNewsUrl, looksOnTopic, MAX_ITEM_AGE_MS, type Source,
} from "./config.js";
import {
  canonicalUrl, fetchFeed, hash, normaliseTitle, titleSimilarity,
} from "./feeds.js";

/** How often the store wakes itself to fetch. */
const FETCH_INTERVAL_MS = 60 * 60 * 1000;
/** Titles at or above this overlap, seen within the window, count as the same story. */
const NEAR_DUPLICATE = 0.6;
const NEAR_DUPLICATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** Items older than this drop off the dashboard. */
export const DASHBOARD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface Item {
  id: string;
  url: string;
  title: string;
  snippet: string;
  source_id: string;
  source_label: string;
  outlet: string;
  section: string;
  lang: string;
  published: number | null;
  first_seen: number;
  /** How many separate sources brought us this story. A crude importance signal. */
  seen_count: number;
  /** Set when this item was folded into another as a near-duplicate. */
  duplicate_of: string | null;
  state: "new" | "kept" | "dropped";
}

export interface ProbeResult {
  source_id: string;
  label: string;
  url: string;
  ok: boolean;
  detail: string;
  items: number;
  checked: number;
}

export class DigestStore extends DurableObject<Cloudflare.Env> {
  #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        norm_title TEXT NOT NULL,
        snippet TEXT NOT NULL DEFAULT '',
        source_id TEXT NOT NULL,
        source_label TEXT NOT NULL DEFAULT '',
        outlet TEXT NOT NULL DEFAULT '',
        section TEXT NOT NULL,
        lang TEXT NOT NULL DEFAULT '',
        published INTEGER,
        first_seen INTEGER NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1,
        duplicate_of TEXT,
        state TEXT NOT NULL DEFAULT 'new'
      );
      CREATE INDEX IF NOT EXISTS items_section ON items (section, first_seen DESC);
      CREATE INDEX IF NOT EXISTS items_seen ON items (first_seen DESC);
      CREATE TABLE IF NOT EXISTS probes (
        source_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        ok INTEGER NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        items INTEGER NOT NULL DEFAULT 0,
        checked INTEGER NOT NULL
      );
      -- Which sources carried a given story. seen_count is derived from this, so
      -- re-fetching the same feed can never inflate it; only a genuinely different
      -- source can. That matters because seen_count is the importance signal.
      CREATE TABLE IF NOT EXISTS item_sources (
        item_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        PRIMARY KEY (item_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /** Record that `sourceId` carried `itemId`, and return the resulting distinct count. */
  #linkSource(itemId: string, sourceId: string): number {
    this.#sql.exec(
      "INSERT OR IGNORE INTO item_sources (item_id, source_id) VALUES (?, ?)",
      itemId, sourceId,
    );
    const n = [...this.#sql.exec(
      "SELECT COUNT(*) AS n FROM item_sources WHERE item_id = ?", itemId,
    )][0].n as number;
    this.#sql.exec("UPDATE items SET seen_count = ? WHERE id = ?", n, itemId);
    return n;
  }

  #get(key: string): string | null {
    const row = [...this.#sql.exec("SELECT value FROM meta WHERE key = ?", key)][0];
    return row ? (row.value as string) : null;
  }

  #put(key: string, value: string): void {
    this.#sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, value,
    );
  }

  /** Idempotent: safe to call on every request. */
  async ensureSchedule(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.refresh();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + FETCH_INTERVAL_MS);
    }
  }

  /** Fetch every enabled source once, storing what is new. Returns per-source results. */
  async refresh(): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    for (const source of SOURCES) {
      if (!source.enabled) continue;
      if (source.kind === "watch") continue;  // page watching lands in a later pass
      results.push(await this.#ingestSource(source));
    }
    this.#put("last_refresh", String(Date.now()));
    return results;
  }

  async #ingestSource(source: Source): Promise<ProbeResult> {
    const url = source.kind === "google-news"
      ? googleNewsUrl(source.query, source.lang ?? "en")
      : source.query;
    const probe: ProbeResult = {
      source_id: source.id, label: source.label, url,
      ok: false, detail: "", items: 0, checked: Date.now(),
    };
    try {
      const items = await fetchFeed(url);
      let stored = 0;
      for (const raw of items) {
        if (await this.#store(source, raw)) stored++;
      }
      probe.ok = true;
      probe.items = stored;
      probe.detail = `${items.length} in feed, ${stored} new`;
    } catch (error) {
      probe.detail = error instanceof Error ? error.message : String(error);
    }
    this.#sql.exec(
      `INSERT INTO probes (source_id, label, url, ok, detail, items, checked)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         label = excluded.label, url = excluded.url, ok = excluded.ok,
         detail = excluded.detail, items = excluded.items, checked = excluded.checked`,
      probe.source_id, probe.label, probe.url, probe.ok ? 1 : 0,
      probe.detail, probe.items, probe.checked,
    );
    return probe;
  }

  /** Returns true when the item was new. Two dedup gates run here, both free. */
  async #store(source: Source, raw: { title: string; link: string; snippet: string; published: number | null; source: string }): Promise<boolean> {
    // Gate 0a: a digest is about now. Google News returns years-old articles for a
    // narrow query, so anything stale is dropped before it reaches the table.
    if (raw.published !== null && Date.now() - raw.published > MAX_ITEM_AGE_MS) return false;

    // Gate 0b: whole-newsroom feeds carry everything. Keep only what looks like our
    // topic. Google News sources skip this, because the query already filtered.
    if (source.requireTopic && !looksOnTopic(`${raw.title} ${raw.snippet}`)) return false;

    const url = canonicalUrl(raw.link);
    const id = await hash(url);

    // Gate 1: exact same article, already known. Count the extra sighting and stop.
    const existing = [...this.#sql.exec("SELECT id FROM items WHERE id = ?", id)][0];
    if (existing) {
      this.#linkSource(id, source.id);
      return false;
    }

    // Gate 2: same story, different URL, same language. Compare normalised titles
    // against the recent window only, so the check stays cheap forever.
    const norm = normaliseTitle(raw.title);
    let duplicateOf: string | null = null;
    const recent = this.#sql.exec(
      "SELECT id, norm_title FROM items WHERE first_seen > ? AND duplicate_of IS NULL",
      Date.now() - NEAR_DUPLICATE_WINDOW_MS,
    );
    for (const row of recent) {
      if (titleSimilarity(norm, row.norm_title as string) >= NEAR_DUPLICATE) {
        duplicateOf = row.id as string;
        break;
      }
    }
    if (duplicateOf) {
      this.#linkSource(duplicateOf, source.id);
    }

    const outlet = raw.source || (() => {
      try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
    })();

    this.#sql.exec(
      `INSERT INTO items (id, url, title, norm_title, snippet, source_id, source_label,
                          outlet, section, lang, published, first_seen, seen_count,
                          duplicate_of, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'new')`,
      id, url, raw.title, norm, raw.snippet, source.id, source.label, outlet,
      source.section, source.lang ?? "", raw.published, Date.now(), duplicateOf,
    );
    this.#linkSource(id, source.id);
    return !duplicateOf;
  }

  /** Items for the dashboard, newest first, duplicates folded away. */
  listSection(section: string, limit: number): Item[] {
    return [...this.#sql.exec(
      `SELECT * FROM items
        WHERE section = ? AND duplicate_of IS NULL AND state != 'dropped'
          AND first_seen > ?
        ORDER BY COALESCE(published, first_seen) DESC, seen_count DESC
        LIMIT ?`,
      section, Date.now() - DASHBOARD_WINDOW_MS, limit,
    )] as unknown as Item[];
  }

  stats(): { total: number; week: number; sections: Record<string, number>; lastRefresh: number | null } {
    const total = [...this.#sql.exec("SELECT COUNT(*) AS n FROM items")][0].n as number;
    const week = [...this.#sql.exec(
      "SELECT COUNT(*) AS n FROM items WHERE first_seen > ? AND duplicate_of IS NULL",
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    )][0].n as number;
    const sections: Record<string, number> = {};
    for (const s of SECTIONS) {
      sections[s.id] = [...this.#sql.exec(
        "SELECT COUNT(*) AS n FROM items WHERE section = ? AND duplicate_of IS NULL AND first_seen > ?",
        s.id, Date.now() - DASHBOARD_WINDOW_MS,
      )][0].n as number;
    }
    const last = this.#get("last_refresh");
    return { total, week, sections, lastRefresh: last ? Number(last) : null };
  }

  probes(): ProbeResult[] {
    return [...this.#sql.exec("SELECT * FROM probes ORDER BY ok, label")]
      .map((r) => ({
        source_id: r.source_id as string, label: r.label as string, url: r.url as string,
        ok: Boolean(r.ok), detail: r.detail as string,
        items: r.items as number, checked: r.checked as number,
      }));
  }

  /** Feeds the Hermes morning brief: the freshest kept items across all sections. */
  brief(limit: number): Item[] {
    return [...this.#sql.exec(
      `SELECT * FROM items
        WHERE duplicate_of IS NULL AND state != 'dropped' AND first_seen > ?
        ORDER BY seen_count DESC, COALESCE(published, first_seen) DESC
        LIMIT ?`,
      Date.now() - 2 * 24 * 60 * 60 * 1000, limit,
    )] as unknown as Item[];
  }

  /**
   * Remove items that predate the current gates: anything published outside the age
   * window, and anything from a topic-gated feed that no longer passes. Lets a config
   * change clean up history instead of only affecting future fetches.
   */
  purgeStale(): number {
    const gated = new Set(SOURCES.filter((s) => s.requireTopic).map((s) => s.id));
    let removed = 0;
    const rows = [...this.#sql.exec(
      "SELECT id, title, snippet, source_id, published FROM items",
    )];
    for (const row of rows) {
      const published = row.published as number | null;
      const tooOld = published !== null && Date.now() - published > MAX_ITEM_AGE_MS;
      const offTopic = gated.has(row.source_id as string)
        && !looksOnTopic(`${row.title as string} ${row.snippet as string}`);
      if (tooOld || offTopic) {
        this.#sql.exec("DELETE FROM items WHERE id = ?", row.id as string);
        this.#sql.exec("DELETE FROM item_sources WHERE item_id = ?", row.id as string);
        removed++;
      }
    }
    return removed;
  }

  /** Drop the one-off FTS5 probe table, if an earlier build created it. */
  dropProbe(): void {
    this.#sql.exec("DROP TABLE IF EXISTS fts_probe");
  }

  setState(id: string, state: "kept" | "dropped"): boolean {
    this.#sql.exec("UPDATE items SET state = ? WHERE id = ?", state, id);
    return true;
  }
}
