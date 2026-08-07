/**
 * The member-facing form, served as one self-contained page by the worker.
 *
 * It talks to the same /api endpoints an agent uses (no private surface), keeping the
 * token in memory from the URL. Design follows the IFB tokens used on drive.impactfinance.be.
 */

export function formPage(orgName: string, roundLabel: string): string {
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
    --rule:#e2ded3; --rule-strong:#cfcabb; --muted:#6b7280;
    --sans:'Helvetica Neue',Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif;
    --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.55}
  .wrap{max-width:820px;margin:0 auto;padding:0 24px}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
  header{background:var(--navy);color:#fff;padding:28px 0 24px}
  header .eyebrow{color:var(--gold)}
  header h1{margin:6px 0 4px;font-size:26px;font-weight:600}
  header p{margin:0;opacity:.85;font-size:14px}
  nav.sections{position:sticky;top:0;z-index:5;background:var(--paper);border-bottom:1px solid var(--rule);
    padding:10px 0;display:flex;gap:6px;overflow-x:auto}
  nav.sections button{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;
    background:none;border:1px solid var(--rule-strong);border-radius:999px;padding:6px 12px;cursor:pointer;
    white-space:nowrap;color:var(--muted)}
  nav.sections button.on{background:var(--navy);border-color:var(--navy);color:#fff}
  main{padding:24px 0 80px}
  .q{background:var(--white);border:1px solid var(--rule);border-radius:10px;padding:16px 18px;margin-bottom:12px}
  .q .label{font-weight:600;margin-bottom:4px}
  .q .help{font-size:13px;color:var(--muted);margin-bottom:8px}
  .badge{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;
    padding:2px 7px;border-radius:999px;margin-left:8px;vertical-align:2px}
  .badge.prefilled{background:#fdf6e2;color:#8a6d1f;border:1px solid var(--gold)}
  .badge.confirmed{background:#eaf3ee;color:#2f6b48;border:1px solid #b9d8c6}
  input[type=text],input[type=number],select,textarea{width:100%;font:inherit;padding:9px 11px;
    border:1px solid var(--rule-strong);border-radius:7px;background:var(--white)}
  textarea{min-height:80px;resize:vertical}
  .opts label{display:block;padding:5px 0;cursor:pointer}
  .opts input{margin-right:8px}
  .bar{position:fixed;left:0;right:0;bottom:0;background:var(--white);border-top:1px solid var(--rule);
    padding:12px 0}
  .bar .wrap{display:flex;align-items:center;gap:14px;justify-content:space-between}
  .status{font-family:var(--mono);font-size:11px;color:var(--muted)}
  button.primary{background:var(--navy);color:#fff;border:0;border-radius:7px;padding:11px 20px;
    font:inherit;font-weight:600;cursor:pointer}
  button.primary[disabled]{opacity:.45;cursor:default}
  .done{background:var(--white);border:1px solid var(--rule);border-radius:10px;padding:28px;text-align:center}
  .done h2{margin:0 0 8px;color:var(--navy)}
  .note{background:#fdf6e2;border:1px solid var(--gold);border-radius:8px;padding:12px 14px;font-size:14px;margin-bottom:18px}
</style>
</head>
<body>
<header><div class="wrap">
  <div class="eyebrow">Impact Finance Belgium</div>
  <h1>${esc(roundLabel)}</h1>
  <p>${esc(orgName)}</p>
</div></header>
<nav class="sections"><div class="wrap" id="tabs"></div></nav>
<main class="wrap" id="main">Loading your questionnaire…</main>
<div class="bar"><div class="wrap">
  <span class="status" id="status">&nbsp;</span>
  <button class="primary" id="submit" disabled>Submit to IFB</button>
</div></div>
<script>
const token = new URLSearchParams(location.search).get("t");
const api = (p, o = {}) => fetch("/api" + p, {
  ...o, headers: { "Authorization": "Bearer " + token, "content-type": "application/json", ...(o.headers||{}) },
}).then(r => r.json());

const SECTION_NAMES = {
  personal: "Contact", general: "General", listed: "Listed investments",
  unlisted_sustainable: "Unlisted sustainable", unlisted_impact: "Unlisted impact",
};
let questions = [], answers = {}, sources = {}, current = null, dirty = {}, submitted = false;

function setStatus(t) { document.getElementById("status").textContent = t; }

function visible(q) {
  if (!q.display_if) return true;
  return answers[q.display_if.code] === q.display_if.equals;
}

function render() {
  const tabs = document.getElementById("tabs");
  const sections = [...new Set(questions.map(q => q.section))];
  if (!current) current = sections[0];
  tabs.innerHTML = "";
  for (const s of sections) {
    const b = document.createElement("button");
    b.textContent = SECTION_NAMES[s] || s;
    b.className = s === current ? "on" : "";
    b.onclick = () => { current = s; render(); window.scrollTo(0, 0); };
    tabs.appendChild(b);
  }
  const main = document.getElementById("main");
  main.innerHTML = "";
  const intro = document.createElement("div");
  intro.className = "note";
  intro.textContent = "Answers marked 'carried over' come from your previous submission. "
    + "Please confirm or update them. Your work saves automatically.";
  main.appendChild(intro);

  for (const q of questions.filter(q => q.section === current && visible(q))) {
    const box = document.createElement("div");
    box.className = "q";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = q.label;
    if (sources[q.code] === "prefilled") label.appendChild(badge("prefilled", "carried over"));
    else if (sources[q.code]) label.appendChild(badge("confirmed", "confirmed this round"));
    box.appendChild(label);
    box.appendChild(field(q));
    main.appendChild(box);
  }
}

function badge(cls, text) {
  const s = document.createElement("span");
  s.className = "badge " + cls;
  s.textContent = text;
  return s;
}

function field(q) {
  const v = answers[q.code];
  if (q.qtype === "select" || q.qtype === "multiselect") {
    const wrap = document.createElement("div");
    wrap.className = "opts";
    for (const opt of q.options || []) {
      const l = document.createElement("label");
      const i = document.createElement("input");
      i.type = q.qtype === "multiselect" ? "checkbox" : "radio";
      i.name = q.code;
      i.checked = q.qtype === "multiselect" ? Array.isArray(v) && v.includes(opt) : v === opt;
      i.onchange = () => {
        if (q.qtype === "multiselect") {
          const set = new Set(Array.isArray(answers[q.code]) ? answers[q.code] : []);
          i.checked ? set.add(opt) : set.delete(opt);
          save(q.code, [...set]);
        } else { save(q.code, opt); render(); }   // re-render: gates may open
      };
      l.appendChild(i);
      l.appendChild(document.createTextNode(opt));
      wrap.appendChild(l);
    }
    return wrap;
  }
  const el = document.createElement(q.qtype === "text" && (q.label.length > 90) ? "textarea" : "input");
  if (el.tagName === "INPUT") el.type = q.qtype === "number" ? "number" : "text";
  el.value = v === undefined || v === null ? "" : v;
  el.onchange = () => save(q.code, q.qtype === "number" ? Number(el.value) : el.value);
  return el;
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

document.getElementById("submit").onclick = async () => {
  if (!confirm("Submit your answers to IFB? You will not be able to change them afterwards.")) return;
  await flush();
  const r = await api("/submit", { method: "POST", body: JSON.stringify({ by: "member:form" }) });
  if (r.ok) done(); else setStatus("could not submit: " + (r.error || "error"));
};

function done() {
  document.querySelector("nav").remove();
  document.querySelector(".bar").remove();
  document.getElementById("main").innerHTML =
    '<div class="done"><h2>Thank you</h2><p>Your response has been submitted to Impact Finance Belgium. '
    + 'IFB will be in touch if anything needs clarification.</p></div>';
}

(async () => {
  const [schema, draft] = await Promise.all([api("/schema"), api("/draft")]);
  if (!schema.questions) { document.getElementById("main").textContent = "This link is no longer valid."; return; }
  questions = schema.questions;
  for (const a of draft.answers) { answers[a.code] = a.value; sources[a.code] = a.source; }
  submitted = draft.status === "submitted";
  if (submitted) { done(); return; }
  document.getElementById("submit").disabled = false;
  render();
  setStatus("loaded");
})();
</script>
</body>
</html>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
