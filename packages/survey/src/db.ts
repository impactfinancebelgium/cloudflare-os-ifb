/**
 * THE data-access module. Every survey query in the worker goes through here.
 *
 * Isolation rule (D1 has no row-level security, so this module IS the security
 * boundary): every member-scoped function takes an `Auth` that was produced by
 * token verification, and every SQL statement filters on auth.orgId + auth.roundId
 * from that object. Nothing in this module ever reads an organisation id from
 * request data. Adversarial tests in test/isolation.sh exercise exactly this.
 */

import type { TokenClaims } from "./token";

export interface Auth {
  orgId: string;
  roundId: string;
}

export const authFromClaims = (c: TokenClaims): Auth => ({ orgId: c.o, roundId: c.r });

export interface Question {
  code: string;
  section: string;
  block: string | null;
  position: number;
  label: string;
  qtype: string;
  options: string[] | null;
  display_if: { code: string; equals: unknown } | null;
  help: string | null;
}

export interface InviteRow {
  round_id: string;
  org_id: string;
  status: string;
  expires_at: string;
}

/** Look up the invite by hashed token; refuses revoked/expired invites. */
export async function inviteForTokenHash(
  db: D1Database, tokenHash: string,
): Promise<InviteRow | null> {
  const row = await db.prepare(
    `SELECT round_id, org_id, status, expires_at FROM survey_invite
     WHERE token_hash = ?1 AND status != 'revoked' AND expires_at > datetime('now')`,
  ).bind(tokenHash).first<InviteRow>();
  return row ?? null;
}

export async function markStarted(db: D1Database, auth: Auth): Promise<void> {
  await db.prepare(
    `UPDATE survey_invite SET status = 'started'
     WHERE round_id = ?1 AND org_id = ?2 AND status = 'invited'`,
  ).bind(auth.roundId, auth.orgId).run();
}

export async function roundMeta(db: D1Database, roundId: string) {
  return db.prepare(
    `SELECT id, label, instrument_version, status FROM survey_round WHERE id = ?1`,
  ).bind(roundId).first();
}

export async function questions(db: D1Database, roundId: string): Promise<Question[]> {
  const rs = await db.prepare(
    `SELECT code, section, block, position, label, qtype, options, display_if, help
     FROM survey_question WHERE round_id = ?1 ORDER BY position`,
  ).bind(roundId).all();
  return (rs.results as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as Question),
    options: r.options ? JSON.parse(r.options as string) : null,
    display_if: r.display_if ? JSON.parse(r.display_if as string) : null,
  }));
}

export interface DraftAnswer {
  code: string;
  value: unknown;
  source: string;
  updated_at: string;
}

export async function draft(db: D1Database, auth: Auth): Promise<{
  status: string; answers: DraftAnswer[];
}> {
  const resp = await db.prepare(
    `SELECT status FROM survey_response WHERE round_id = ?1 AND org_id = ?2`,
  ).bind(auth.roundId, auth.orgId).first<{ status: string }>();
  const rs = await db.prepare(
    `SELECT code, value, source, updated_at FROM survey_answer
     WHERE round_id = ?1 AND org_id = ?2 ORDER BY code`,
  ).bind(auth.roundId, auth.orgId).all();
  return {
    status: resp?.status ?? "draft",
    answers: (rs.results as Record<string, unknown>[]).map((r) => ({
      code: r.code as string,
      value: r.value ? JSON.parse(r.value as string) : null,
      source: r.source as string,
      updated_at: r.updated_at as string,
    })),
  };
}

/** Upsert a batch of answers for the token's org. Rejects after submission. */
export async function patchDraft(
  db: D1Database, auth: Auth, answers: Record<string, unknown>, source: "member" | "agent",
): Promise<{ written: number } | { error: string }> {
  const resp = await db.prepare(
    `SELECT status FROM survey_response WHERE round_id = ?1 AND org_id = ?2`,
  ).bind(auth.roundId, auth.orgId).first<{ status: string }>();
  if (resp?.status === "submitted") return { error: "already_submitted" };

  const valid = new Set((await questions(db, auth.roundId)).map((q) => q.code));
  const entries = Object.entries(answers).filter(([code]) => valid.has(code));
  if (!entries.length) return { written: 0 };

  const stmts = entries.map(([code, value]) => db.prepare(
    `INSERT INTO survey_answer (round_id, org_id, code, value, source, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
     ON CONFLICT (round_id, org_id, code)
     DO UPDATE SET value = ?4, source = ?5, updated_at = datetime('now')`,
  ).bind(auth.roundId, auth.orgId, code, JSON.stringify(value), source));
  stmts.push(db.prepare(
    `INSERT OR IGNORE INTO survey_response (round_id, org_id, status) VALUES (?1, ?2, 'draft')`,
  ).bind(auth.roundId, auth.orgId));
  await db.batch(stmts);
  return { written: entries.length };
}

export async function submit(
  db: D1Database, auth: Auth, submittedBy: string,
): Promise<{ ok: true } | { error: string }> {
  const resp = await db.prepare(
    `SELECT status FROM survey_response WHERE round_id = ?1 AND org_id = ?2`,
  ).bind(auth.roundId, auth.orgId).first<{ status: string }>();
  if (resp?.status === "submitted") return { error: "already_submitted" };
  await db.batch([
    db.prepare(
      `INSERT INTO survey_response (round_id, org_id, status, submitted_at, submitted_by)
       VALUES (?1, ?2, 'submitted', datetime('now'), ?3)
       ON CONFLICT (round_id, org_id)
       DO UPDATE SET status='submitted', submitted_at=datetime('now'), submitted_by=?3`,
    ).bind(auth.roundId, auth.orgId, submittedBy.slice(0, 200)),
    db.prepare(
      `UPDATE survey_invite SET status = 'submitted' WHERE round_id = ?1 AND org_id = ?2`,
    ).bind(auth.roundId, auth.orgId),
  ]);
  return { ok: true };
}

// ---- ops / gatekeeper-facing (never returns answer values) -------------------

export async function createInvite(
  db: D1Database,
  args: { roundId: string; orgId: string; orgName: string; email?: string;
          tokenHash: string; expiresAt: string },
): Promise<void> {
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO survey_org (id, name) VALUES (?1, ?2)`)
      .bind(args.orgId, args.orgName),
    db.prepare(
      `INSERT INTO survey_invite (round_id, org_id, contact_email, token_hash, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (round_id, org_id)
       DO UPDATE SET contact_email=?3, token_hash=?4, expires_at=?5, status='invited'`,
    ).bind(args.roundId, args.orgId, args.email ?? null, args.tokenHash, args.expiresAt),
  ]);
}

export async function roundProgress(db: D1Database, roundId: string) {
  return db.prepare(
    `SELECT
       (SELECT count(*) FROM survey_invite WHERE round_id = ?1) AS invited,
       (SELECT count(*) FROM survey_invite WHERE round_id = ?1 AND status='started') AS started,
       (SELECT count(*) FROM survey_invite WHERE round_id = ?1 AND status='submitted') AS submitted`,
  ).bind(roundId).first();
}
