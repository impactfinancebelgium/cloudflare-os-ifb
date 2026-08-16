// The app registry. Config-as-personality again: this list IS the launcher.
// Adding a tool to IFB means adding a line here, reviewed in git.
//
// Grouped by what a person wants to DO, not by what the tool is called. Nobody
// opens their morning thinking "I need the Durable Object dashboard".

export interface AppLink {
  id: string;
  name: string;
  /** One line, in plain words. What you would tell a colleague it is for. */
  blurb: string;
  url: string;
  group: string;
  /** Emoji stands in for an icon set we do not need yet. */
  icon: string;
  /** Checked for liveness on the dashboard. Access-gated apps answer 302, which is healthy. */
  check?: boolean;
  /** Shown as a small tag: who this is mainly for, or a caveat. */
  tag?: string;
}

export const GROUPS = [
  "Members and contacts",
  "Publishing",
  "Knowledge and monitoring",
  "Agents",
] as const;

export const APPS: AppLink[] = [
  {
    id: "crm",
    name: "Twenty CRM",
    blurb: "Members, contacts, companies and the membership pipeline.",
    url: "https://crm.impactfinance.be/",
    group: "Members and contacts",
    icon: "👥",
    check: true,
  },
  {
    id: "survey",
    name: "Market survey",
    blurb: "Send the survey, track who has answered, read the aggregates.",
    url: "https://survey.impactfinance.be/",
    group: "Members and contacts",
    icon: "📊",
    check: true,
    tag: "members sign in by invite link",
  },
  {
    id: "website",
    name: "Website (new)",
    blurb: "The rebuilt impactfinance.be, still on its test address.",
    url: "https://new.impactfinance.be/",
    group: "Publishing",
    icon: "🌐",
    check: true,
    tag: "not yet the live domain",
  },
  {
    id: "drive",
    name: "Drive",
    blurb: "Published documents: the AI plan, the handbook, photos.",
    url: "https://drive.impactfinance.be/",
    group: "Publishing",
    icon: "📁",
    check: true,
  },
  {
    id: "digest",
    name: "Media digest",
    blurb: "What the press wrote about impact finance, collected and deduplicated.",
    url: "https://digest.impactfinance.net/",
    group: "Knowledge and monitoring",
    icon: "📰",
    check: true,
    tag: "collection view; not yet reviewed",
  },
  {
    id: "os",
    name: "Cloudflare OS",
    blurb: "Chat with an agent that can reach the CRM, the website and our documents.",
    url: "https://os.impactfinance.be/",
    group: "Agents",
    icon: "🤖",
    check: true,
    tag: "pilot",
  },
  {
    id: "cabinet",
    name: "Cabinet",
    blurb: "The older agent workspace on the IFB server.",
    url: "https://cabinet.impactfinance.net/",
    group: "Agents",
    icon: "🗄️",
    check: true,
    tag: "being replaced",
  },
];

/** Anything reachable only from a terminal or Slack, listed so people know it exists. */
export const NON_WEB = [
  { name: "Hermes (Slack)", blurb: "Ask the workspace a question from Slack. Runs the morning brief." },
  { name: "The workspace repo", blurb: "Every document, decision and skill, in git. Read by every agent." },
];
