// The team digest dashboard. Glance's layout grammar (pages -> columns -> widgets,
// server-rendered, cached, mobile-first) applied to IFB's sections, in IFB's colours.
//
// One deliberate Glance behaviour is kept: the page does NOT auto-refresh. Something
// people check once a morning should never move under them or nag for attention.

import { SECTIONS, type Section } from "./config.js";
import type { Item, ProbeResult } from "./store.js";

const NAVY = "#0d1b3e";
const CORAL = "#ff5a3c";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));

function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function itemRow(item: Item): string {
  const when = item.published ?? item.first_seen;
  const badge = item.seen_count > 1
    ? `<span class="badge" title="${item.seen_count} sources carried this">${item.seen_count}x</span>`
    : "";
  return `<li class="item">
    <a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
    <div class="meta">
      <span class="outlet">${esc(item.outlet || item.source_label)}</span>
      <span class="dot">.</span><span>${ago(when)}</span>
      ${item.lang ? `<span class="dot">.</span><span class="lang">${esc(item.lang)}</span>` : ""}
      ${badge}
    </div>
  </li>`;
}

function widget(section: Section, items: Item[]): string {
  const body = items.length
    ? `<ul class="items">${items.map(itemRow).join("")}</ul>`
    : `<p class="empty">Nothing yet.</p>`;
  return `<section class="widget">
    <h2>${esc(section.title)} <span class="count">${items.length}</span></h2>
    ${body}
  </section>`;
}

export interface DashboardData {
  bySection: Map<string, Item[]>;
  stats: { total: number; week: number; lastRefresh: number | null };
  probes: ProbeResult[];
}

export function renderDashboard(data: DashboardData): string {
  const column = (n: 1 | 2 | 3) => SECTIONS
    .filter((s) => s.column === n)
    .map((s) => widget(s, data.bySection.get(s.id) ?? []))
    .join("");

  const broken = data.probes.filter((p) => !p.ok);
  const health = broken.length
    ? `<div class="warn"><strong>${broken.length} source${broken.length > 1 ? "s" : ""} failing:</strong> ${
        broken.map((p) => esc(p.label)).join(", ")
      }. <a href="/admin/probe">Details</a></div>`
    : "";

  const refreshed = data.stats.lastRefresh
    ? `updated ${ago(data.stats.lastRefresh)} ago`
    : "not yet fetched";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IFB media digest</title>
<style>
  :root { --navy:${NAVY}; --coral:${CORAL}; --line:#e6e8ef; --muted:#6b7280; --bg:#faf9f7; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--navy);
    font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  header { padding:22px 24px 14px; border-bottom:1px solid var(--line); background:#fff; }
  h1 { margin:0; font-size:20px; letter-spacing:-0.3px; }
  h1 span { color:var(--coral); }
  .sub { color:var(--muted); font-size:13px; margin-top:4px; }
  .warn { margin:14px 24px 0; padding:10px 12px; border-radius:8px;
    background:#fff4f1; border:1px solid #ffd9d0; font-size:13px; }
  .warn a { color:var(--coral); }
  main { display:grid; gap:18px; padding:18px 24px 40px;
    grid-template-columns: 2fr 1.15fr 1.15fr; align-items:start; }
  @media (max-width: 1000px) { main { grid-template-columns:1fr; } }
  .widget { background:#fff; border:1px solid var(--line); border-radius:10px;
    padding:14px 16px; margin-bottom:18px; }
  .widget h2 { margin:0 0 10px; font-size:13px; text-transform:uppercase;
    letter-spacing:0.6px; color:var(--muted); display:flex; gap:8px; align-items:center; }
  .count { background:var(--bg); border:1px solid var(--line); border-radius:20px;
    padding:1px 7px; font-size:11px; color:var(--muted); }
  ul.items { list-style:none; margin:0; padding:0; }
  .item { padding:9px 0; border-top:1px solid var(--line); }
  .item:first-child { border-top:0; padding-top:0; }
  .item a { color:var(--navy); text-decoration:none; font-weight:500; }
  .item a:hover { color:var(--coral); text-decoration:underline; }
  .meta { margin-top:3px; font-size:12px; color:var(--muted); display:flex;
    gap:5px; align-items:center; flex-wrap:wrap; }
  .outlet { font-weight:500; }
  .dot { opacity:0.4; }
  .lang { text-transform:uppercase; font-size:10px; letter-spacing:0.5px; }
  .badge { background:var(--coral); color:#fff; border-radius:20px; padding:0 6px;
    font-size:10px; font-weight:600; }
  .empty { color:var(--muted); font-size:13px; margin:2px 0; }
  footer { padding:0 24px 30px; color:var(--muted); font-size:12px; }
</style>
</head><body>
<header>
  <h1>IFB media digest <span>.</span></h1>
  <div class="sub">${data.stats.week} items this week &middot; ${data.stats.total} tracked &middot; ${refreshed}</div>
</header>
${health}
<main>
  <div>${column(1)}</div>
  <div>${column(2)}</div>
  <div>${column(3)}</div>
</main>
<footer>
  Sources are configured in <code>packages/digest/src/config.ts</code>.
  Nothing here has been through a human review yet; this is the raw collection view.
</footer>
</body></html>`;
}

export function renderProbes(probes: ProbeResult[]): string {
  const rows = probes.map((p) => `<tr class="${p.ok ? "ok" : "bad"}">
    <td>${p.ok ? "OK" : "FAIL"}</td>
    <td>${esc(p.label)}</td>
    <td>${esc(p.detail)}</td>
    <td>${p.items}</td>
    <td><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">feed</a></td>
  </tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Digest source health</title><style>
 body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:24px;color:#0d1b3e;}
 table{border-collapse:collapse;width:100%;} td,th{border-bottom:1px solid #e6e8ef;padding:7px 9px;text-align:left;}
 tr.bad td:first-child{color:#c0392b;font-weight:700;} tr.ok td:first-child{color:#128a4b;}
 a{color:#ff5a3c;}
</style></head><body>
<h1>Source health</h1>
<p>Probed from the Worker, which is what matters: laptop results do not predict Worker results.</p>
<table><tr><th></th><th>Source</th><th>Detail</th><th>New</th><th></th></tr>${rows}</table>
</body></html>`;
}
