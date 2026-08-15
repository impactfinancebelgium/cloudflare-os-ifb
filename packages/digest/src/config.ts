// Config-as-personality: this file IS the product definition. Sources on or off,
// sections, limits. Changing what IFB watches is a change here, reviewed in git,
// not a code change. (Pattern borrowed from tool-daily-briefing; the point is that
// a non-technical team can ask an agent to edit one file.)
//
// Every source is public and free. Nothing here needs a key.

export type SourceKind = "google-news" | "feed" | "watch";

export interface Source {
  id: string;
  kind: SourceKind;
  /** Shown in the dashboard and the digest. */
  label: string;
  /** google-news: the query. feed/watch: the URL. */
  query: string;
  /** google-news only: hl/gl/ceid, so FR, NL and EN each get their own pass. */
  lang?: "fr" | "nl" | "en";
  /** Which dashboard section this feeds. */
  section: string;
  enabled: boolean;
  /**
   * Publisher feeds carry a whole newsroom, so an item only counts if it looks like
   * our topic. Google News sources skip this: the query already is the filter.
   */
  requireTopic?: boolean;
}

/**
 * The topic gate for whole-newsroom feeds. Deliberately broad and multilingual: it
 * is a noise filter, not the relevance judgement. The LLM pass makes the real call
 * later; this only stops a general-interest feed flooding the table.
 */
export const TOPIC_TERMS: string[] = [
  "impact financ", "impact invest", "impactinvest", "impactfinanc",
  "finance à impact", "investissement à impact", "duurzame financier",
  "finance durable", "sustainable financ", "sustainable invest",
  "esg", "sfdr", "csrd", "taxonom", "blended financ", "catalytic",
  "capital catalytique", "microfinanc", "sociale impact", "social impact",
  "green bond", "obligation verte", "groene obligatie", "philanthrop",
  "impactfonds", "impact fund", "febelfin", "fsma",
];

export function looksOnTopic(text: string): boolean {
  const haystack = text.toLowerCase();
  return TOPIC_TERMS.some((term) => haystack.includes(term));
}

/**
 * Items published longer ago than this are not ingested. Google News happily returns
 * years-old articles for a narrow query, and a digest is about what is happening now.
 *
 * Measured on the first live run (2026-08-16): of 324 items returned across 12
 * sources, only about a dozen were published in the last six weeks. Belgian
 * impact-finance coverage is genuinely thin, which is exactly why the alerts pile up
 * slowly and unread. Ninety days keeps a useful backfill while still excluding the
 * long tail of 2-year-old articles Google keeps returning.
 */
export const MAX_ITEM_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface Section {
  id: string;
  title: string;
  /** Dashboard column: 1 is the wide main column, 2 and 3 are the side columns. */
  column: 1 | 2 | 3;
  /** Most items to show in the dashboard for this section. */
  limit: number;
}

// The Eurosif / Spainsif section shape: policy first, consultations next, then the
// network and events. Reordering here reorders the dashboard and the digest.
export const SECTIONS: Section[] = [
  { id: "highlights", title: "Highlights", column: 1, limit: 12 },
  { id: "policy", title: "Policy and regulation", column: 1, limit: 10 },
  { id: "market", title: "Market and instruments", column: 2, limit: 8 },
  { id: "ifb", title: "IFB mentions", column: 2, limit: 8 },
  { id: "consultations", title: "Consultations and calls", column: 3, limit: 6 },
];

const GN = (id: string, q: string, lang: "fr" | "nl" | "en", section: string): Source => ({
  id, kind: "google-news", label: q, query: q, lang, section, enabled: true,
});

// Starter set. The real ~30 Google Alert keywords are not documented anywhere in the
// workspace yet (see the proposal, section 10); these are the obvious stand-ins and
// are meant to be replaced once Lynn provides the list.
export const SOURCES: Source[] = [
  // Highlights: the core topic, one pass per language.
  GN("gn-if-fr", "\"finance à impact\" OR \"investissement à impact\"", "fr", "highlights"),
  GN("gn-if-nl", "\"impactinvesteren\" OR \"impactfinanciering\"", "nl", "highlights"),
  GN("gn-if-en", "\"impact investing\" Belgium", "en", "highlights"),

  // Policy and regulation.
  GN("gn-pol-fr", "\"finance durable\" (SFDR OR taxonomie OR régulation)", "fr", "policy"),
  GN("gn-pol-nl", "\"duurzame financiering\" (SFDR OR taxonomie OR regelgeving)", "nl", "policy"),
  GN("gn-pol-en", "sustainable finance (SFDR OR taxonomy OR omnibus) Belgium", "en", "policy"),

  // Market and instruments.
  GN("gn-mkt-fr", "\"capital catalytique\" OR \"obligation à impact\"", "fr", "market"),
  GN("gn-mkt-nl", "\"blended finance\" OR \"sociale impactobligatie\"", "nl", "market"),

  // Anything naming IFB itself. This is the separate flag the contract asks for.
  GN("gn-ifb-1", "\"Impact Finance Belgium\"", "en", "ifb"),
  GN("gn-ifb-2", "\"Impact Finance Belgium\"", "fr", "ifb"),

  // Publisher feeds. Verified reachable from a laptop on 2026-08-15; each still has to
  // prove itself from a Worker, which is what /admin/probe is for. Le Soir is left out
  // deliberately: it 403s every user agent.
  { id: "f-tijd", kind: "feed", label: "De Tijd", query: "https://www.tijd.be/rss/top_stories.xml", section: "market", enabled: true, requireTopic: true },
  { id: "f-bruzz", kind: "feed", label: "Bruzz", query: "https://www.bruzz.be/rss.xml", section: "market", enabled: false, requireTopic: true },
  { id: "f-alter", kind: "feed", label: "Alter Echos", query: "https://www.alterechos.be/feed/", section: "market", enabled: true, requireTopic: true },

  // Policy pages worth watching for change. The changedetection.io idea, as a table
  // rather than a fourth service to host. Disabled until Jonas confirms the list.
  { id: "w-fsma", kind: "watch", label: "FSMA news", query: "https://www.fsma.be/en/news", section: "consultations", enabled: false },
  { id: "w-eu", kind: "watch", label: "EU have your say", query: "https://ec.europa.eu/info/law/better-regulation/have-your-say_en", section: "consultations", enabled: false },
];

/** Google News search feed for a query. Served by Google, so publisher blocks do not apply. */
export function googleNewsUrl(query: string, lang: "fr" | "nl" | "en"): string {
  const ceid = lang === "en" ? "BE:en" : lang === "fr" ? "BE:fr" : "BE:nl";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
    `&hl=${lang}&gl=BE&ceid=${encodeURIComponent(ceid)}`;
}

export const sectionById = (id: string): Section | undefined =>
  SECTIONS.find((s) => s.id === id);
