declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "TwentyGatekeeper";
  }
}

// Deploy-time secrets (wrangler secret put); not in wrangler.jsonc so not generated.
declare namespace Cloudflare {
  interface Env {
    TWENTY_API_KEY?: string;
    CF_ACCESS_CLIENT_ID?: string;
    CF_ACCESS_CLIENT_SECRET?: string;
  }
}
