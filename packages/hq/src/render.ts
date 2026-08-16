// The HQ page. Two jobs, in this order: get me to the tool I need, and tell me
// where the work stands. Everything above the fold is a link someone can click.

import { APPS, GROUPS, NON_WEB, type AppLink } from "./apps.js";
import type { Health, Project } from "./store.js";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));

function ago(ms: number | null): string {
  if (!ms) return "never";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const STATUS_COLOUR: Record<string, string> = {
  active: "var(--green)",
  "in progress": "var(--green)",
  blocked: "var(--coral)",
  paused: "var(--amber)",
  planned: "var(--muted)",
  done: "var(--navy)",
  complete: "var(--navy)",
};

function card(app: AppLink, health: Health | undefined): string {
  const dot = !app.check
    ? ""
    : health?.ok
      ? `<span class="dot up" title="reachable (HTTP ${health.code})"></span>`
      : `<span class="dot down" title="not reachable${health ? ` (HTTP ${health.code})` : ""}"></span>`;
  return `<a class="card" href="${esc(app.url)}" target="_blank" rel="noopener noreferrer">
    <div class="card-top">
      <span class="ico">${app.icon}</span>
      <span class="card-name">${esc(app.name)}</span>
      ${dot}
    </div>
    <p class="blurb">${esc(app.blurb)}</p>
    ${app.tag ? `<span class="tag">${esc(app.tag)}</span>` : ""}
  </a>`;
}

function projectRow(p: Project): string {
  const key = (p.status || "").toLowerCase();
  const colour = STATUS_COLOUR[key] ?? "var(--muted)";
  const tasks = p.openTasks > 0
    ? `<span class="tasks">${p.openTasks} open</span>` : "";
  return `<tr>
    <td><span class="pill" style="background:${colour}">${esc(p.status || "?")}</span></td>
    <td class="p-title">${esc(p.title)}${tasks}</td>
    <td class="p-sum">${esc(p.summary)}</td>
    <td class="p-meta">${esc(p.owner || "")}</td>
    <td class="p-meta">${esc(p.updated || "")}</td>
  </tr>`;
}

export function renderHq(
  health: Health[],
  projects: Project[],
  projectsUpdated: number | null,
): string {
  const byId = new Map(health.map((h) => [h.id, h]));
  const groups = GROUPS.map((group) => {
    const apps = APPS.filter((a) => a.group === group);
    if (!apps.length) return "";
    return `<section class="group">
      <h2>${esc(group)}</h2>
      <div class="cards">${apps.map((a) => card(a, byId.get(a.id))).join("")}</div>
    </section>`;
  }).join("");

  const down = APPS.filter((a) => a.check && byId.get(a.id)?.ok === false);
  const banner = down.length
    ? `<div class="warn"><strong>${down.length} application${down.length > 1 ? "s" : ""} not responding:</strong> ${
        down.map((a) => esc(a.name)).join(", ")}.</div>`
    : "";

  const board = projects.length
    ? `<table class="projects">
        <tr><th></th><th>Project</th><th>Where it stands</th><th>Lead</th><th>Updated</th></tr>
        ${projects.map(projectRow).join("")}
      </table>
      <p class="note">From the project notes in the workspace, refreshed ${ago(projectsUpdated)}.
      The repository stays the source of truth; this is a read-only view of it.</p>`
    : `<p class="empty">No project data yet. It arrives on the next push from the workspace.</p>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IFB HQ</title>
<style>
  :root { --navy:#0d1b3e; --coral:#ff5a3c; --green:#128a4b; --amber:#c98a00;
    --line:#e6e8ef; --muted:#6b7280; --bg:#faf9f7; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--navy);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  header { padding:26px 28px 18px; background:#fff; border-bottom:1px solid var(--line); }
  h1 { margin:0; font-size:22px; letter-spacing:-0.3px; }
  h1 span { color:var(--coral); }
  .sub { color:var(--muted); font-size:13px; margin-top:5px; }
  .warn { margin:16px 28px 0; padding:10px 13px; border-radius:8px;
    background:#fff4f1; border:1px solid #ffd9d0; font-size:13px; }
  main { padding:22px 28px 48px; max-width:1200px; }
  .group { margin-bottom:26px; }
  .group h2 { font-size:12px; text-transform:uppercase; letter-spacing:0.7px;
    color:var(--muted); margin:0 0 11px; }
  .cards { display:grid; gap:13px; grid-template-columns:repeat(auto-fill,minmax(255px,1fr)); }
  .card { display:block; background:#fff; border:1px solid var(--line); border-radius:11px;
    padding:14px 15px; text-decoration:none; color:inherit; transition:border-color .12s,transform .12s; }
  .card:hover { border-color:var(--coral); transform:translateY(-1px); }
  .card-top { display:flex; align-items:center; gap:9px; }
  .ico { font-size:19px; }
  .card-name { font-weight:600; }
  .dot { width:8px; height:8px; border-radius:50%; margin-left:auto; }
  .dot.up { background:var(--green); }
  .dot.down { background:var(--coral); }
  .blurb { margin:7px 0 0; font-size:13px; color:var(--muted); }
  .tag { display:inline-block; margin-top:9px; font-size:11px; color:var(--muted);
    border:1px solid var(--line); border-radius:20px; padding:1px 8px; }
  h2.section { font-size:12px; text-transform:uppercase; letter-spacing:0.7px;
    color:var(--muted); margin:34px 0 11px; }
  table.projects { width:100%; border-collapse:collapse; background:#fff;
    border:1px solid var(--line); border-radius:11px; overflow:hidden; }
  .projects th { text-align:left; font-size:11px; text-transform:uppercase;
    letter-spacing:0.6px; color:var(--muted); padding:9px 12px; border-bottom:1px solid var(--line); }
  .projects td { padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; font-size:13.5px; }
  .projects tr:last-child td { border-bottom:0; }
  .pill { color:#fff; border-radius:20px; padding:1px 9px; font-size:11px;
    font-weight:600; white-space:nowrap; }
  .p-title { font-weight:600; white-space:nowrap; }
  .tasks { margin-left:8px; font-weight:400; font-size:11px; color:var(--coral); }
  .p-sum { color:var(--muted); }
  .p-meta { color:var(--muted); font-size:12px; white-space:nowrap; }
  .note, .empty { color:var(--muted); font-size:12px; margin-top:10px; }
  .other { display:flex; gap:22px; flex-wrap:wrap; margin-top:10px; }
  .other div { font-size:13px; }
  .other strong { display:block; }
  .other span { color:var(--muted); font-size:12px; }
</style>
</head><body>
<header>
  <h1>Impact Finance Belgium <span>HQ</span></h1>
  <div class="sub">Everything the team can open, and where the work stands.</div>
</header>
${banner}
<main>
  ${groups}
  <h2 class="section">Projects</h2>
  ${board}
  <h2 class="section">Not a web page</h2>
  <div class="other">
    ${NON_WEB.map((n) => `<div><strong>${esc(n.name)}</strong><span>${esc(n.blurb)}</span></div>`).join("")}
  </div>
</main>
</body></html>`;
}
