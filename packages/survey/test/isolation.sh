#!/usr/bin/env bash
# Adversarial isolation tests for the survey worker (the build gate from the brief).
#
#   BASE=https://ifb-os-survey.… SURVEY_ADMIN_KEY=… bash test/isolation.sh
#
# D1 has no row-level security, so src/db.ts is the security boundary; these tests
# attack it from outside: cross-org reads, org ids smuggled in bodies, tampered and
# expired tokens, revoked invites. Every case must FAIL CLOSED.
set -u
BASE="${BASE:?set BASE}"; KEY="${SURVEY_ADMIN_KEY:?set SURVEY_ADMIN_KEY}"
ROUND="ifb-2025-demo"
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  PASS  $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1"; }

# Fresh invites for two orgs (re-mint is idempotent: replaces the token).
TOK_A=$(curl -s -X POST "$BASE/api/admin/invite" -H "x-admin-key: $KEY" -H "content-type: application/json" \
  -d "{\"round_id\":\"$ROUND\",\"org_id\":\"demo:bank\",\"org_name\":\"Demo Bank Belgium\"}" \
  | sed -n 's/.*t=\([^"]*\).*/\1/p')
TOK_B=$(curl -s -X POST "$BASE/api/admin/invite" -H "x-admin-key: $KEY" -H "content-type: application/json" \
  -d "{\"round_id\":\"$ROUND\",\"org_id\":\"demo:foundation\",\"org_name\":\"Demo Foundation\"}" \
  | sed -n 's/.*t=\([^"]*\).*/\1/p')
[ -n "$TOK_A" ] && [ -n "$TOK_B" ] || { echo "could not mint demo invites"; exit 1; }

# 1. Each token sees only its own org in the draft.
A_ORG=$(curl -s "$BASE/api/draft" -H "Authorization: Bearer $TOK_A" | python3 -c "import json,sys;print(json.load(sys.stdin).get('org',''))")
B_ORG=$(curl -s "$BASE/api/draft" -H "Authorization: Bearer $TOK_B" | python3 -c "import json,sys;print(json.load(sys.stdin).get('org',''))")
[ "$A_ORG" = "demo:bank" ] && [ "$B_ORG" = "demo:foundation" ] \
  && ok "each token is scoped to its own organisation" \
  || bad "token/org scoping broken (A=$A_ORG B=$B_ORG)"

# 2. Org id smuggled in the body is ignored: write with A's token "as" org B.
MARK="isolation-$(date +%s)"
curl -s -X PATCH "$BASE/api/draft" -H "Authorization: Bearer $TOK_A" -H "content-type: application/json" \
  -d "{\"org_id\":\"demo:foundation\",\"answers\":{\"general.q2\":\"$MARK\"}}" >/dev/null
B_SEES=$(curl -s "$BASE/api/draft" -H "Authorization: Bearer $TOK_B" | grep -c "$MARK")
A_SEES=$(curl -s "$BASE/api/draft" -H "Authorization: Bearer $TOK_A" | grep -c "$MARK")
[ "$B_SEES" = "0" ] && [ "$A_SEES" = "1" ] \
  && ok "body-smuggled org id ignored; write landed on the token's org only" \
  || bad "cross-org write leak (A_SEES=$A_SEES B_SEES=$B_SEES)"

# 3. Tampered token refused.
TAMPERED="${TOK_A%?}x"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/draft" -H "Authorization: Bearer $TAMPERED")
[ "$CODE" = "401" ] && ok "tampered signature refused (401)" || bad "tampered token got $CODE"

# 4. Garbage token refused.
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/draft" -H "Authorization: Bearer not.a.token")
[ "$CODE" = "401" ] && ok "garbage token refused (401)" || bad "garbage token got $CODE"

# 5. No token refused.
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/draft")
[ "$CODE" = "401" ] && ok "missing token refused (401)" || bad "missing token got $CODE"

# 6. Re-minting an invite revokes the previous token (hash no longer matches).
curl -s -X POST "$BASE/api/admin/invite" -H "x-admin-key: $KEY" -H "content-type: application/json" \
  -d "{\"round_id\":\"$ROUND\",\"org_id\":\"demo:bank\",\"org_name\":\"Demo Bank Belgium\"}" >/dev/null
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/draft" -H "Authorization: Bearer $TOK_A")
[ "$CODE" = "401" ] && ok "superseded token refused after re-mint (401)" || bad "old token still valid: $CODE"

# 7. Admin endpoint refuses a wrong key.
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/admin/invite" -H "x-admin-key: wrong" \
  -H "content-type: application/json" -d '{"round_id":"x","org_id":"y","org_name":"z"}')
[ "$CODE" = "401" ] && ok "admin endpoint refuses bad key (401)" || bad "admin with bad key got $CODE"

echo; echo "isolation: $pass passed, $fail failed"
[ "$fail" = "0" ]
