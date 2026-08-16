-- IFB recruitment application schema (D1 / SQLite). Self-contained recruitment mini app:
-- candidates are stored inline on the application row (no CRM contacts here), CVs live in R2
-- (the CVS binding). Idempotent: safe to re-apply. Constraints mirror the former Supabase
-- recruitment schema; screening rules live in workflows/internship-recruiting.md.

CREATE TABLE IF NOT EXISTS recruitment_opening (
  id           TEXT PRIMARY KEY,          -- slug, e.g. 'internship-2026'
  role_title   TEXT NOT NULL,
  role_slug    TEXT,
  start_target TEXT,                       -- target start month, e.g. 'September 2026'
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recruitment_application (
  id               TEXT PRIMARY KEY,       -- uuid (crypto.randomUUID)
  opening_id       TEXT REFERENCES recruitment_opening(id),
  position_applied TEXT,
  source           TEXT NOT NULL DEFAULT 'website_form'
                   CHECK (source IN ('website_form','email','referral','other')),
  -- candidate
  first_name       TEXT,
  last_name        TEXT,
  email            TEXT,
  -- intake (what the website form collects)
  cv_key           TEXT,                   -- R2 object key for the CV
  cover_letter_key TEXT,                   -- R2 object key for an optional cover-letter file
  motivation_text  TEXT,
  start_month      TEXT,
  months_available TEXT,
  full_or_part_time TEXT,
  university       TEXT,
  study_level      TEXT,
  mandatory_for_studies INTEGER,           -- 0 / 1 / null
  country_residence TEXT,
  nationality      TEXT,
  lang_en TEXT CHECK (lang_en IS NULL OR lang_en IN ('fluent','knowledge','none')),
  lang_fr TEXT CHECK (lang_fr IS NULL OR lang_fr IN ('fluent','knowledge','none')),
  lang_nl TEXT CHECK (lang_nl IS NULL OR lang_nl IN ('fluent','knowledge','none')),
  -- screening (filled by the recruiting skill / staff)
  finance_experience TEXT,                 -- 'No' | 'Yes (University)' | 'Yes (Professional)' | 'Yes (Both)'
  impact_experience  TEXT,
  start_fit    TEXT CHECK (start_fit IS NULL OR start_fit IN ('good','ok','off')),
  score        TEXT CHECK (score IS NULL OR score IN ('good','maybe','not_good')),
  score_comment TEXT,
  -- pipeline
  stage        TEXT NOT NULL DEFAULT 'applied'
               CHECK (stage IN ('applied','cv_screen','interview_1','interview_2','decision')),
  status       TEXT DEFAULT 'in_review'
               CHECK (status IS NULL OR status IN ('in_review','advanced','shortlisted','offered','hired','rejected','withdrawn')),
  decision     TEXT,
  notes        TEXT,
  retain_until TEXT,
  applied_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_stage ON recruitment_application (stage);
CREATE INDEX IF NOT EXISTS idx_app_email ON recruitment_application (email);
CREATE INDEX IF NOT EXISTS idx_app_opening ON recruitment_application (opening_id);
