declare namespace Cloudflare {
  interface Env {
    DIGEST: DurableObjectNamespace;
    /** Bearer secret for /api/brief, read by the Hermes morning brief. */
    BRIEF_TOKEN?: string;
  }
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "DigestStore";
  }
}
