declare namespace Cloudflare {
  interface Env {
    HQ: DurableObjectNamespace;
    /** Bearer secret for POST /api/projects, held by the workspace pre-push hook. */
    HQ_TOKEN?: string;
  }
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "HqStore";
  }
}
