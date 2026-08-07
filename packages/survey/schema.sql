-- IFB market-survey application schema (D1 / SQLite).
-- Design per projects/market-survey/survey-app-proposal.md in ifb-workspace:
-- questions are DATA (a new round is a content change, not a migration) and answers are
-- ROWS keyed by stable question codes, each carrying its provenance (`source`).
-- Idempotent: safe to re-apply.

CREATE TABLE IF NOT EXISTS survey_round (
  id                 TEXT PRIMARY KEY,          -- e.g. 'ifb-2025', 'ifb-2025-demo'
  label              TEXT NOT NULL,
  instrument_version TEXT NOT NULL,
  opens_at           TEXT,
  closes_at          TEXT,
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','open','closed'))
);

CREATE TABLE IF NOT EXISTS survey_question (
  round_id   TEXT NOT NULL REFERENCES survey_round(id),
  code       TEXT NOT NULL,                     -- stable across rounds; carries comparability
  section    TEXT NOT NULL,                     -- e.g. 'general', 'listed', 'outlook'
  block      TEXT,                              -- NULL or a conditional category block key
  position   INTEGER NOT NULL,
  label      TEXT NOT NULL,
  qtype      TEXT NOT NULL
             CHECK (qtype IN ('text','number','select','multiselect','percent_split','boolean')),
  options    TEXT,                              -- JSON array for select/multiselect/percent_split
  display_if TEXT,                              -- JSON {"code": "...", "equals": ...}
  help       TEXT,
  PRIMARY KEY (round_id, code)
);

-- Organisations are referenced by the Twenty CRM id where one exists; demo orgs use a
-- 'demo:' prefix. The survey app never mirrors CRM detail beyond the display name.
CREATE TABLE IF NOT EXISTS survey_org (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS survey_invite (
  round_id       TEXT NOT NULL REFERENCES survey_round(id),
  org_id         TEXT NOT NULL REFERENCES survey_org(id),
  contact_email  TEXT,                          -- demo rows hold placeholders, never real mail
  token_hash     TEXT NOT NULL,                 -- sha256(token); the raw token is never stored
  expires_at     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'invited'
                 CHECK (status IN ('invited','started','submitted','revoked')),
  reminders_sent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (round_id, org_id)
);

CREATE TABLE IF NOT EXISTS survey_response (
  round_id     TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','submitted')),
  submitted_at TEXT,
  submitted_by TEXT,                            -- attribution: 'member:<email>' | 'agent:<name>'
  PRIMARY KEY (round_id, org_id)
);

CREATE TABLE IF NOT EXISTS survey_answer (
  round_id   TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  code       TEXT NOT NULL,
  value      TEXT,                              -- JSON-encoded
  source     TEXT NOT NULL DEFAULT 'member'
             CHECK (source IN ('prefilled','member','agent','interview','trawl')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (round_id, org_id, code)
);

-- Raw ingests (Qualtrics exports, Word transcriptions) for reconciliation and audit.
CREATE TABLE IF NOT EXISTS survey_import (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id   TEXT,
  org_id     TEXT,
  channel    TEXT NOT NULL,                     -- 'qualtrics' | 'word' | 'interview'
  payload    TEXT NOT NULL,                     -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_answer_org ON survey_answer (org_id, round_id);
CREATE INDEX IF NOT EXISTS idx_invite_token ON survey_invite (token_hash);
