/**
 * The agent-handoff page (the questionnaire itself lives in form-page.ts).
 */

/** The agent-handoff page: how a member lets their own agent complete the survey. */
export function agentPage(origin: string, roundId: string, token: string, orgName: string): string {
  const mcpUrl = `${origin}/mcp?t=${token}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Let your assistant fill it in - Impact Finance Belgium</title>
<style>
  :root{--ink:#14181f;--paper:#f7f5f0;--white:#fff;--navy:#113f5e;--gold:#d3c388;
    --rule:#e2ded3;--muted:#6b7280;
    --sans:'Helvetica Neue',Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif;
    --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.6}
  .wrap{max-width:760px;margin:0 auto;padding:0 24px}
  header{background:var(--navy);color:#fff;padding:26px 0 22px}
  header .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}
  header h1{margin:6px 0 0;font-size:24px}
  main{padding:26px 0 60px}
  h2{font-size:17px;color:var(--navy);margin:26px 0 8px}
  p{margin:8px 0}
  pre{background:#0e2a3d;color:#e8eef2;font-family:var(--mono);font-size:12.5px;line-height:1.5;
    padding:14px 16px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
  .card{background:var(--white);border:1px solid var(--rule);border-radius:10px;padding:18px 20px;margin:14px 0}
  .note{background:#fdf6e2;border:1px solid var(--gold);border-radius:8px;padding:12px 14px;font-size:14px}
  a{color:var(--navy)}
</style>
</head>
<body>
<header><div class="wrap">
  <div class="eyebrow">Impact Finance Belgium - Market survey</div>
  <h1>Let your assistant fill it in</h1>
</div></header>
<main class="wrap">
  <p>${esc(orgName)}: you can complete the survey yourself in the
  <a href="/r/${esc(roundId)}?t=${token}">web form</a>, or hand it to your own AI assistant.
  Both use the same personal link, and your previous answers are already filled in either way.</p>

  <h2>Option 1 - Claude Code (or any MCP client)</h2>
  <div class="card">
    <p>Run this once to connect the survey:</p>
    <pre>claude mcp add --transport http ifb-survey "${mcpUrl}"</pre>
    <p>Then ask, for example:</p>
    <pre>Please review our IFB market survey draft. Most answers are carried over
from our previous submission: check them against our current figures,
fill in what is missing (ask me where you need numbers), and show me a
summary. Do not submit until I approve.</pre>
  </div>

  <h2>Option 2 - plain HTTP, for any other tooling</h2>
  <div class="card">
    <pre>GET  ${origin}/api/schema   # the questionnaire
GET  ${origin}/api/draft    # your pre-filled draft
PATCH ${origin}/api/draft   # {"answers": {"&lt;code&gt;": &lt;value&gt;}}
POST ${origin}/api/submit   # {"by": "agent:&lt;name&gt;"}

Authorization: Bearer &lt;the token from your invite link&gt;</pre>
    <p>A machine-readable guide lives at <a href="/api/agent-guide">/api/agent-guide</a>.</p>
  </div>

  <div class="note"><strong>Good to know.</strong> Your link is personal to your organisation:
  do not share it outside the people and tools you trust to act for you. Submission is final,
  and your assistant is asked to get your explicit approval before submitting. IFB only ever
  publishes aggregated results, never your organisation's individual answers.</div>
</main>
</body>
</html>`;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
