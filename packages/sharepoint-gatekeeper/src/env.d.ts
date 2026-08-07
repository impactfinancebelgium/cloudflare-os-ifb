declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "SharePointGatekeeper";
  }
}

// Deploy-time secret (wrangler secret put); not in wrangler.jsonc so not generated.
declare namespace Cloudflare {
  interface Env {
    MS_CLIENT_SECRET?: string;
  }
}
