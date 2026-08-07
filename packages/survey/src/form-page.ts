/**
 * The member-facing questionnaire, one self-contained page in the IFB design system.
 *
 * Views: welcome (landing with progress + handoff link) -> form (sections with
 * per-section progress, pre-fill badges, autosave) -> review (summary before the
 * irreversible submit) -> done. Talks to the same /api endpoints agents use.
 */

export function formPage(orgName: string, roundLabel: string, roundId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(roundLabel)} - Impact Finance Belgium</title>
<style>
  :root{
    --ink:#14181f; --paper:#f7f5f0; --paper2:#efece4; --white:#fff;
    --navy:#113f5e; --navy-deep:#0a2a3f; --gold:#d3c388; --coral:#f15d49;
    --rule:#e2ded3; --rule-strong:#cfcabb; --muted:#6b7280; --green:#2f6b48;
    --sans:'Helvetica Neue',Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif;
    --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.6}
  .wrap{max-width:780px;margin:0 auto;padding:0 22px}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}

  header{background:var(--navy);color:#fff;padding:22px 0 18px}
  header .eyebrow{color:var(--gold)}
  header h1{margin:5px 0 2px;font-size:22px;font-weight:600;letter-spacing:-.01em}
  header .org{margin:0;opacity:.85;font-size:13.5px}
  .headbar{display:flex;justify-content:space-between;align-items:flex-end;gap:16px}
  .headprog{text-align:right;font-family:var(--mono);font-size:11px;color:var(--gold);white-space:nowrap}
  .headprog .track{width:120px;height:4px;background:rgba(255,255,255,.18);border-radius:99px;margin-top:6px}
  .headprog .fill{height:4px;background:var(--gold);border-radius:99px;transition:width .3s}

  nav.sections{position:sticky;top:0;z-index:5;background:var(--paper);border-bottom:1px solid var(--rule);padding:9px 0}
  nav.sections .wrap{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}
  nav.sections button{font-family:var(--mono);font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;
    background:var(--white);border:1px solid var(--rule-strong);border-radius:999px;padding:6px 12px;cursor:pointer;
    white-space:nowrap;color:var(--muted);transition:all .15s}
  nav.sections button:hover{border-color:var(--navy);color:var(--navy)}
  nav.sections button.on{background:var(--navy);border-color:var(--navy);color:#fff}
  nav.sections button .n{opacity:.75;margin-left:5px}
  nav.sections button .tick{color:var(--green);margin-left:5px}
  nav.sections button.on .tick{color:var(--gold)}

  main{padding:22px 0 96px}
  .sechead{margin:4px 0 14px}
  .sechead h2{margin:0 0 2px;font-size:17px;color:var(--navy)}
  .sechead .sub{font-size:13px;color:var(--muted)}

  .q{background:var(--white);border:1px solid var(--rule);border-radius:10px;padding:15px 18px 16px;margin-bottom:10px;
    transition:box-shadow .15s,border-color .15s}
  .q:focus-within{border-color:var(--navy);box-shadow:0 1px 6px rgba(17,63,94,.10)}
  .q .qnum{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;margin-bottom:3px}
  .q .label{font-weight:600;font-size:14.5px;line-height:1.45;margin-bottom:9px}
  .badge{display:inline-block;font-family:var(--mono);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;
    padding:2px 7px;border-radius:999px;margin-left:8px;vertical-align:1px}
  .badge.prefilled{background:#fdf6e2;color:#8a6d1f;border:1px solid var(--gold)}
  .badge.confirmed{background:#eaf3ee;color:var(--green);border:1px solid #b9d8c6}

  input[type=text],textarea,.numwrap input{width:100%;font:inherit;font-size:14px;padding:9px 12px;
    border:1px solid var(--rule-strong);border-radius:7px;background:var(--white);transition:border-color .15s}
  input:focus,textarea:focus{outline:none;border-color:var(--navy)}
  textarea{min-height:84px;resize:vertical}
  .numwrap{position:relative}
  .numwrap input{padding-right:44px;font-family:var(--mono);font-size:13.5px}
  .numwrap .unit{position:absolute;right:12px;top:50%;transform:translateY(-50%);
    font-family:var(--mono);font-size:11px;color:var(--muted)}

  .opts label{display:flex;align-items:flex-start;gap:9px;padding:6px 8px;margin:0 -8px;border-radius:7px;
    cursor:pointer;font-size:14px;line-height:1.45;transition:background .12s}
  .opts label:hover{background:var(--paper)}
  .opts input{margin-top:3px;accent-color:var(--navy);flex:none}

  .bar{position:fixed;left:0;right:0;bottom:0;background:var(--white);border-top:1px solid var(--rule);
    padding:11px 0;box-shadow:0 -2px 10px rgba(20,24,31,.05)}
  .bar .wrap{display:flex;align-items:center;gap:14px;justify-content:space-between}
  .status{font-family:var(--mono);font-size:10.5px;color:var(--muted)}
  button.primary{background:var(--navy);color:#fff;border:0;border-radius:7px;padding:10px 20px;
    font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
  button.primary:hover{background:var(--navy-deep)}
  button.primary[disabled]{opacity:.45;cursor:default}
  button.ghost{background:none;border:1px solid var(--rule-strong);border-radius:7px;padding:10px 18px;
    font:inherit;font-size:14px;color:var(--ink);cursor:pointer}
  button.ghost:hover{border-color:var(--navy);color:var(--navy)}

  .panel{background:var(--white);border:1px solid var(--rule);border-radius:12px;padding:26px 28px;margin-top:6px}
  .panel h2{margin:0 0 10px;font-size:19px;color:var(--navy)}
  .panel p{margin:8px 0;font-size:14.5px}
  .note{background:#fdf6e2;border:1px solid var(--gold);border-radius:8px;padding:11px 14px;font-size:13.5px;margin:14px 0}
  .agentlink{display:block;background:var(--paper);border:1px dashed var(--rule-strong);border-radius:8px;
    padding:12px 14px;font-size:13.5px;margin:14px 0;color:inherit;text-decoration:none}
  .agentlink:hover{border-color:var(--navy)}
  .agentlink b{color:var(--navy)}

  .rev{display:flex;justify-content:space-between;align-items:center;padding:11px 2px;border-bottom:1px solid var(--rule);font-size:14px}
  .rev:last-of-type{border-bottom:0}
  .rev .cnt{font-family:var(--mono);font-size:12px;color:var(--muted)}
  .rev .cnt.full{color:var(--green)}
  .revwarn{font-size:13px;color:#8a6d1f;background:#fdf6e2;border-radius:7px;padding:9px 12px;margin-top:12px}
  .actions{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}

  .done{background:var(--white);border:1px solid var(--rule);border-radius:12px;padding:34px 28px;text-align:center;margin-top:14px}
  .done h2{margin:0 0 8px;color:var(--navy)}
  .done p{color:var(--muted);font-size:14.5px}
</style>
</head>
<body>
<header><div class="wrap headbar">
  <div>
    <div class="eyebrow">Impact Finance Belgium</div>
    <h1>${esc(roundLabel)}</h1>
    <p class="org">${esc(orgName)}</p>
  </div>
  <div class="headprog" id="headprog" hidden>
    <span id="progtext"></span>
    <div class="track"><div class="fill" id="progfill" style="width:0%"></div></div>
  </div>
</div></header>
<nav class="sections" id="nav" hidden><div class="wrap" id="tabs"></div></nav>
<main class="wrap" id="main"><div class="panel"><p>Loading your questionnaire…</p></div></main>
<div class="bar" id="bar" hidden><div class="wrap">
  <span class="status" id="status">&nbsp;</span>
  <span style="display:flex;gap:10px">
    <button class="ghost" id="toreview">Review &amp; submit</button>
  </span>
</div></div>
<script>
const ROUND = ${JSON.stringify(roundId)};
const token = new URLSearchParams(location.search).get("t");
const api = (p, o = {}) => fetch("/api" + p, {
  ...o, headers: { "Authorization": "Bearer " + token, "content-type": "application/json", ...(o.headers||{}) },
}).then(r => r.json());

const SECTION_META = {
  personal: ["Contact", "Who to reach if IFB has a question about your answers."],
  general: ["General", "Your organisation and total assets under management."],
  listed: ["Listed investments", "Sustainable and/or impact listed investments."],
  unlisted_sustainable: ["Unlisted sustainable", "Sustainable unlisted investments."],
  unlisted_impact: ["Unlisted impact", "Impact unlisted investments."],
};
let questions = [], answers = {}, sources = {}, current = null, dirty = {}, view = "welcome";

const $ = (id) => document.getElementById(id);
const setStatus = (t) => { $("status").textContent = t; };
const visible = (q) => !q.display_if || answers[q.display_if.code] === q.display_if.equals;
const answered = (q) => {
  const v = answers[q.code];
  return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
};
const isEuro = (q) => /euro|assets under management/i.test(q.label);
const fmt = (n) => Number(n).toLocaleString("en-GB");

function counts() {
  const per = {};
  let tot = 0, done = 0;
  for (const q of questions) {
    if (!visible(q)) continue;
    const p = per[q.section] ?? (per[q.section] = { total: 0, done: 0 });
    p.total++; tot++;
    if (answered(q)) { p.done++; done++; }
  }
  return { per, tot, done };
}

function renderChrome() {
  const { per, tot, done } = counts();
  $("headprog").hidden = view === "welcome";
  $("progtext").textContent = done + " / " + tot + " answered";
  $("progfill").style.width = (tot ? Math.round(100 * done / tot) : 0) + "%";
  $("nav").hidden = view !== "form";
  $("bar").hidden = view !== "form";
  const tabs = $("tabs");
  tabs.innerHTML = "";
  for (const s of [...new Set(questions.map((q) => q.section))]) {
    const p = per[s] ?? { total: 0, done: 0 };
    const b = document.createElement("button");
    b.className = s === current ? "on" : "";
    b.innerHTML = (SECTION_META[s]?.[0] ?? s)
      + (p.done >= p.total && p.total ? '<span class="tick">✓</span>'
         : '<span class="n">' + p.done + "/" + p.total + "</span>");
    b.onclick = () => { current = s; view = "form"; render(); window.scrollTo(0, 0); };
    tabs.appendChild(b);
  }
}

function render() {
  renderChrome();
  if (view === "welcome") return renderWelcome();
  if (view === "review") return renderReview();
  renderForm();
}

function renderWelcome() {
  const { tot, done } = counts();
  const pre = Object.values(sources).filter((s) => s === "prefilled").length;
  const m = $("main");
  m.innerHTML = "";
  const p = el("div", "panel");
  p.appendChild(el("h2", null, "Welcome"));
  p.appendChild(el("p", null,
    "This questionnaire feeds IFB's market study of sustainable and impact investing in Belgium. "
    + "It covers " + tot + " questions across " + Object.keys(SECTION_META).length
    + " sections; sections that do not apply to you stay closed."));
  if (pre) p.appendChild(el("div", "note",
    pre + " answers are carried over from your previous submission. Your job is to confirm or "
    + "update them, not to start from scratch. Everything saves automatically as you go."));
  const a = el("a", "agentlink");
  a.href = "/r/" + ROUND + "/agent" + location.search;
  a.innerHTML = "<b>Prefer to delegate?</b> Hand this survey to your own AI assistant "
    + "(Claude Code or any MCP client) and review before submitting. →";
  p.appendChild(a);
  const act = el("div", "actions");
  const start = el("button", "primary", done ? "Continue (" + done + "/" + tot + " answered)" : "Start");
  start.onclick = () => { view = "form"; render(); };
  act.appendChild(start);
  p.appendChild(act);
  p.appendChild(el("p", null,
    "IFB treats your answers confidentially and only ever publishes aggregated results."));
  m.appendChild(p);
}

function renderForm() {
  const m = $("main");
  m.innerHTML = "";
  const [name, sub] = SECTION_META[current] ?? [current, ""];
  const head = el("div", "sechead");
  head.appendChild(el("h2", null, name));
  head.appendChild(el("div", "sub", sub));
  m.appendChild(head);

  let n = 0;
  for (const q of questions.filter((q) => q.section === current && visible(q))) {
    n++;
    const box = el("div", "q");
    box.appendChild(el("div", "qnum", "Question " + n));
    const label = el("div", "label", q.label);
    if (sources[q.code] === "prefilled") label.appendChild(badge("prefilled", "carried over"));
    else if (sources[q.code]) label.appendChild(badge("confirmed", "confirmed this round"));
    box.appendChild(label);
    box.appendChild(field(q));
    m.appendChild(box);
  }
}

function renderReview() {
  const { per } = counts();
  const m = $("main");
  m.innerHTML = "";
  const p = el("div", "panel");
  p.appendChild(el("h2", null, "Review before submitting"));
  let missing = 0;
  for (const s of [...new Set(questions.map((q) => q.section))]) {
    const c = per[s] ?? { total: 0, done: 0 };
    missing += c.total - c.done;
    const row = el("div", "rev");
    row.appendChild(el("span", null, SECTION_META[s]?.[0] ?? s));
    row.appendChild(el("span", "cnt" + (c.done >= c.total ? " full" : ""), c.done + " / " + c.total));
    row.onclick = () => { current = s; view = "form"; render(); };
    row.style.cursor = "pointer";
    p.appendChild(row);
  }
  if (missing) p.appendChild(el("div", "revwarn",
    missing + " question(s) are still open. You can submit anyway; IFB may follow up for the gaps."));
  const act = el("div", "actions");
  const back = el("button", "ghost", "Back to the form");
  back.onclick = () => { view = "form"; render(); };
  const go = el("button", "primary", "Submit to IFB (final)");
  go.onclick = doSubmit;
  act.appendChild(back); act.appendChild(go);
  p.appendChild(act);
  p.appendChild(el("p", null, "Submitting locks your answers for this round."));
  m.appendChild(p);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function badge(cls, text) { const s = el("span", "badge " + cls, text); return s; }

function field(q) {
  const v = answers[q.code];
  if (q.qtype === "select" || q.qtype === "multiselect") {
    const wrap = el("div", "opts");
    for (const opt of q.options || []) {
      const l = el("label");
      const i = document.createElement("input");
      i.type = q.qtype === "multiselect" ? "checkbox" : "radio";
      i.name = q.code;
      i.checked = q.qtype === "multiselect" ? Array.isArray(v) && v.includes(opt) : v === opt;
      i.onchange = () => {
        if (q.qtype === "multiselect") {
          const set = new Set(Array.isArray(answers[q.code]) ? answers[q.code] : []);
          i.checked ? set.add(opt) : set.delete(opt);
          save(q.code, [...set]);
          renderChrome();
        } else { save(q.code, opt); render(); }
      };
      l.appendChild(i);
      l.appendChild(document.createTextNode(opt));
      wrap.appendChild(l);
    }
    return wrap;
  }
  if (q.qtype === "number") {
    const wrap = el("div", "numwrap");
    const i = document.createElement("input");
    i.type = "text"; i.inputMode = "numeric";
    i.value = v === undefined || v === null || v === "" ? "" : fmt(v);
    i.onfocus = () => { i.value = String(answers[q.code] ?? "").replace(/[^0-9.]/g, ""); };
    i.onblur = () => {
      const raw = i.value.replace(/[^0-9.]/g, "");
      if (raw === "") return;
      const n = Number(raw);
      if (Number.isFinite(n)) { save(q.code, n); i.value = fmt(n); renderChrome(); }
    };
    wrap.appendChild(i);
    if (isEuro(q)) wrap.appendChild(el("span", "unit", "EUR"));
    return wrap;
  }
  const long = q.label.length > 90;
  const e = document.createElement(long ? "textarea" : "input");
  if (!long) e.type = "text";
  e.value = v === undefined || v === null ? "" : v;
  e.onchange = () => { save(q.code, e.value); renderChrome(); };
  return e;
}

function save(code, value) {
  answers[code] = value;
  sources[code] = "member";
  dirty[code] = value;
  setStatus("saving…");
  clearTimeout(save._t);
  save._t = setTimeout(flush, 600);
}

async function flush() {
  const batch = dirty; dirty = {};
  if (!Object.keys(batch).length) return;
  const r = await api("/draft", { method: "PATCH", body: JSON.stringify({ answers: batch }) });
  setStatus(r.ok ? "saved " + new Date().toLocaleTimeString() : "not saved: " + (r.error || "error"));
}

$("toreview").onclick = () => { view = "review"; render(); window.scrollTo(0, 0); };

async function doSubmit() {
  await flush();
  const r = await api("/submit", { method: "POST", body: JSON.stringify({ by: "member:form" }) });
  if (r.ok) done(); else setStatus("could not submit: " + (r.error || "error"));
}

function done() {
  view = "done";
  $("nav").hidden = true; $("bar").hidden = true; $("headprog").hidden = true;
  $("main").innerHTML = '<div class="done"><h2>Thank you</h2>'
    + "<p>Your response has been submitted to Impact Finance Belgium.<br/>"
    + "IFB will be in touch if anything needs clarification.</p></div>";
}

(async () => {
  const [schema, draft] = await Promise.all([api("/schema"), api("/draft")]);
  if (!schema.questions) {
    $("main").innerHTML = '<div class="panel"><p>This link is no longer valid. Contact IFB for a fresh one.</p></div>';
    return;
  }
  questions = schema.questions;
  for (const a of draft.answers) { answers[a.code] = a.value; sources[a.code] = a.source; }
  if (draft.status === "submitted") { done(); return; }
  render();
  setStatus("loaded");
})();
</script>
</body>
</html>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
