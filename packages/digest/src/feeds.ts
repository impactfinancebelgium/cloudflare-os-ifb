// Feed fetching and normalisation. No dependencies: RSS and Atom are regular enough
// that a small parser beats pulling a library into a Worker, and it keeps the bundle
// tiny. Anything that does not parse is skipped rather than throwing, because one bad
// feed must never stop the run.

export interface RawItem {
  title: string;
  link: string;
  /** Publisher-supplied snippet. Often all we get, and often all we need. */
  snippet: string;
  published: number | null;
  /** Outlet name where the feed gives one (Google News does). */
  source: string;
}

const tag = (xml: string, name: string): string | null => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : null;
};

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Atom links live in an attribute, RSS links in the element body. */
function atomLink(block: string): string {
  const href = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    ?? block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return href ? href[1] : "";
}

export function parseFeed(xml: string): RawItem[] {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
  const out: RawItem[] = [];
  for (const block of blocks) {
    const title = decode(tag(block, "title") ?? "");
    let link = decode(tag(block, "link") ?? "");
    if (!link || link.length < 8) link = atomLink(block);
    if (!title || !link) continue;
    const snippet = decode(
      tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content") ?? "",
    ).slice(0, 1200);
    const dateStr = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated");
    const parsed = dateStr ? Date.parse(decode(dateStr)) : NaN;
    out.push({
      title,
      link,
      snippet,
      published: Number.isFinite(parsed) ? parsed : null,
      source: decode(tag(block, "source") ?? ""),
    });
  }
  return out;
}

const TRACKING = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref_?$|igshid|si$)/i;

/**
 * Canonical URL: the dedup key. Google News wraps every link in a redirect with the
 * real target in `url`, so unwrap that first, then drop tracking parameters, the
 * fragment, and a trailing slash. Two alerts for the same article then collapse to
 * one row without any model being involved.
 */
export function canonicalUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim();
  }
  const wrapped = url.searchParams.get("url");
  if (wrapped && /^https?:/i.test(wrapped)) {
    try {
      url = new URL(wrapped);
    } catch { /* keep the outer url */ }
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  url.protocol = "https:";
  url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
  let s = url.toString();
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Stable 64-bit-ish hash of a string, hex. Used as the primary key for an item. */
export async function hash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Titles normalised for near-duplicate comparison: lowercase, no punctuation, no
 * outlet suffix after a pipe or dash. Two alerts on the same story from the same
 * outlet often differ only in that suffix.
 */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .split(/\s+[|–—-]\s+/)[0]
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard overlap of word sets. Cheap same-language near-duplicate check. */
export function titleSimilarity(a: string, b: string): number {
  const wa = new Set(a.split(" ").filter((w) => w.length > 3));
  const wb = new Set(b.split(" ").filter((w) => w.length > 3));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

export async function fetchFeed(url: string): Promise<RawItem[]> {
  const response = await fetch(url, {
    headers: {
      // Identify honestly. Some publishers allow a named crawler where they block curl.
      "user-agent": "IFB-digest/1.0 (+https://impactfinance.be; contact hello@impactfinance.be)",
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseFeed(await response.text());
}
