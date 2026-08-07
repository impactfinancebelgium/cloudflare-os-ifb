# IFB market survey

The member survey application for IFB's biennial market study: Worker + D1
(`ifb-survey`, region WEUR), member-facing over signed invite tokens, staff-facing
through the "Market survey (IFB)" card in Cloudflare OS. Design authority lives in
`ifb-workspace`: `projects/market-survey/survey-app-proposal.md` and
`docs/decisions/2026-08-06-cloudflare-as-the-whole-stack.md`.

Live at `https://ifb-os-survey.impact-finance-belgium.workers.dev`.

## How it fits together

- **Questions are data, answers are rows.** A round's instrument lives in
  `survey_question` (seeded from the Word questionnaire by
  `ifb-workspace/scripts/survey/parse-instrument.py`); a new round is a content
  change, not a schema migration. Every answer records its provenance in `source`:
  `prefilled` (carried over), `member`, `agent`, `interview`, `trawl`.
- **The invite link is the credential.** `token.ts` mints HMAC-signed tokens binding
  organisation + round + expiry; validity also requires the token's hash to match a
  live `survey_invite` row, so re-minting an invite revokes the old link. No
  Cloudflare Access for members (per-seat pricing), no auth vendor.
- **`db.ts` is the security boundary.** D1 has no row-level security, so isolation
  is application discipline: every member-scoped query goes through this one module
  and filters on the organisation id from the verified token, never from request
  data. `test/isolation.sh` attacks exactly this contract and must stay green.

## Member flow

`GET /r/<round>?t=<token>`: welcome (pre-fill explainer, delegate option) -> form
(sections with progress, carried-over vs confirmed badges, autosave) -> review ->
submit (final; locks the draft).

## Agent flow

Same authority, same data; a member can hand the survey to their own agent:

- **MCP**: `claude mcp add --transport http ifb-survey "https://<host>/mcp?t=<token>"`.
  Tools: `get_schema`, `get_draft`, `update_answers`, `submit_response` (which
  refuses without `confirmed_by_human: true`).
- **REST**: `GET /api/schema`, `GET /api/draft`, `PATCH /api/draft`,
  `POST /api/submit`, `Authorization: Bearer <token>`.
- `GET /r/<round>/agent?t=…` is the member-facing handoff page;
  `GET /api/agent-guide` is the machine brief.

## Ops

- **Mint an invite** (staff only; the response contains the personal link, which is
  never emailed by this worker):

  ```
  curl -X POST https://<host>/api/admin/invite \
    -H "x-admin-key: <SURVEY_ADMIN_KEY>" -H "content-type: application/json" \
    -d '{"round_id":"…","org_id":"<twenty company id>","org_name":"…","email":"…"}'
  ```

- **Cloudflare OS**: the `GATEKEEPER_SURVEY` card exposes `listRounds`,
  `roundProgress`, `listInvites` (completion tracking) and `roundResults`
  (aggregates). No verb returns a per-organisation answer value; text answers are
  counted, never quoted.
- **Secrets** on `ifb-os-survey`: `SURVEY_TOKEN_SECRET`, `SURVEY_ADMIN_KEY` (vault
  item "Survey app secrets"). D1 admin ops need the account-wide token; deploys use
  the `ifb-os-deploy` token.
- **Real-data import** is staged in
  `ifb-workspace/scripts/survey/import-past-responses.py` (dry-run by design;
  applying its SQL is a reviewed human step).
- Seed/refresh the demo round: `python3 scripts/survey/parse-instrument.py --demo`
  in ifb-workspace, then `wrangler d1 execute ifb-survey --remote --file
  /tmp/ifb-survey-seed.sql -y`.

## Confidentiality

Per-organisation answers (AUM above all) are confidential to IFB: only aggregates
ever leave the application, and the OS gatekeeper enforces that in code. A
minimum-respondents suppression threshold for published aggregates is a pending
policy decision (flagged to Solène).
