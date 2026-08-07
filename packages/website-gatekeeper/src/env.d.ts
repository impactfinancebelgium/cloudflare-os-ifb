declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "WebsiteGatekeeper";
  }
}

// Deploy-time secret (wrangler secret put); not in wrangler.jsonc so not generated.
declare namespace Cloudflare {
  interface Env {
    WEBSITE_GITHUB_TOKEN?: string;
  }
}
