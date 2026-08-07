// IFB website Gatekeeper: the team's way to instruct changes to the public website
// repo (impactfinance-belgium-website) from inside Cloudflare OS. Agents can read
// the repo freely (recorded observations); the ONLY write path is proposeChange,
// which queues an action for HUMAN APPROVAL in the OS. Only when approved does
// applyAction() commit the edits DIRECTLY TO THE DEFAULT BRANCH, which deploys:
// Jonas approved this on 2026-08-08 because the site runs on a test domain, not
// the live impactfinance.be. When the site goes live, flip DIRECT_TO_MAIN back to
// false and proposals return to review branches + compare URLs. Auth: the org
// fine-grained PAT as a Worker secret.

import {
  DurableObject,
  RpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  WebsiteChangeProposal,
  WebsiteEntry,
  WebsiteFileChange,
  WebsiteSession,
} from "./types.js";
import TYPES_CODE from "./types-code.js";

const WEBSITE_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='20'><circle cx='128' cy='128' r='88'/><path d='M40 128h176M128 40c24 24 36 56 36 88s-12 64-36 88c-24-24-36-56-36-88s12-64 36-88z'/></svg>",
    ),
};

const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES_PER_CHANGE = 20;

// Test-domain mode: approved changes commit straight to the default branch (and
// deploy). Set to false once impactfinance.be goes live on this repo, to get
// review branches + compare URLs back.
const DIRECT_TO_MAIN = true;

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation" | "submitAction"> &
  Partial<{ [Symbol.dispose](): void }>;

// What we store per proposal in the DO (files included until applied).
type StoredProposal = WebsiteChangeProposal & { description: string; files?: WebsiteFileChange[] };

export function describeWebsiteVendor(): VendorDescription {
  return {
    displayName: "IFB website",
    url: "https://github.com/impactfinancebelgium/impactfinance-belgium-website",
    logo: WEBSITE_ICON,
    color: "#eefaf2",
    tagline: "Propose changes to impactfinance.be",
    description:
      "Read the website's source and propose changes. Every proposal needs human approval in the OS; approved changes commit to main and deploy (the site is on a test domain).",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeWebsiteAccount(): AccountDescription {
  return {
    displayName: "IFB website",
    avatar: WEBSITE_ICON,
    singleton: { tsType: "WebsiteSession" },
  };
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "change";
}

function b64encodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function githubApi(env: Cloudflare.Env, path: string, method = "GET", body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${env.WEBSITE_REPO}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.WEBSITE_GITHUB_TOKEN ?? ""}`,
      accept: "application/vnd.github+json",
      "user-agent": "ifb-os-website-gatekeeper",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub request failed (${response.status} on ${method} ${path}).`);
  }
  if (response.status === 404) return null;
  return method === "DELETE" ? {} : response.json();
}

@validateRpc()
export class WebsiteSessionImpl extends RpcTarget implements WebsiteSession {
  readonly #approvalQueue: ObservationQueue;
  readonly #gatekeeper: WebsiteGatekeeper;
  readonly #env: Cloudflare.Env;

  constructor(approvalQueue: ObservationQueue, gatekeeper: WebsiteGatekeeper, env: Cloudflare.Env) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#gatekeeper = gatekeeper;
    this.#env = env;
  }

  async listFiles(dir: string): Promise<WebsiteEntry[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "List website files",
      description: `List "${dir || "/"}" in the website repository.`,
    });
    const clean = dir.replace(/^\/+|\/+$/g, "");
    const body = await githubApi(this.#env, `/contents/${encodeURI(clean)}`);
    if (!Array.isArray(body)) throw new Error("Path is not a listable directory.");
    return (body as Array<{ path: string; type: string; size: number }>).map((e) => ({
      path: e.path,
      type: e.type === "dir" ? "dir" : "file",
      size: e.size ?? 0,
    }));
  }

  async readFile(path: string): Promise<string> {
    await this.#approvalQueue.authorizeObservation({
      title: "Read a website file",
      description: `Read "${path}" from the website repository.`,
    });
    const clean = path.replace(/^\/+/, "");
    const body = (await githubApi(this.#env, `/contents/${encodeURI(clean)}`)) as {
      type?: string; size?: number; content?: string;
    } | null;
    if (!body || body.type !== "file" || typeof body.content !== "string") {
      throw new Error("Path is not a readable file.");
    }
    if ((body.size ?? 0) > MAX_FILE_BYTES) throw new Error("File is too large to read here.");
    const bin = atob(body.content.replace(/\n/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async proposeChange(
    title: string,
    description: string,
    files: WebsiteFileChange[],
  ): Promise<WebsiteChangeProposal> {
    if (!files.length) throw new Error("A change proposal needs at least one file.");
    if (files.length > MAX_FILES_PER_CHANGE) {
      throw new Error(`A change proposal may touch at most ${MAX_FILES_PER_CHANGE} files.`);
    }
    for (const file of files) {
      if (new TextEncoder().encode(file.content).length > MAX_FILE_BYTES) {
        throw new Error(`File "${file.path}" is too large for a proposal.`);
      }
    }

    const proposalId = await this.#gatekeeper.enqueueProposal(title, description, files);
    await this.#approvalQueue.submitAction(proposalId, {
      title: `Website change: ${title}`,
      description:
        `${description}\n\n**Files:** ${files.map((f) => `\`${f.path}\``).join(", ")}\n\n` +
        (DIRECT_TO_MAIN
          ? "On approval this commits straight to the default branch and the test site deploys."
          : "On approval this creates a review branch on GitHub. A human still opens and merges " +
            "the pull request; the live site does not change until then."),
      // Direct-to-main commits can't be cleanly rolled back from here.
      implementsRevert: !DIRECT_TO_MAIN,
      // Reads don't reflect the pending change, so let the agent pause until decided.
      awaitDecision: true,
    });
    return { proposalId, status: "pending", title };
  }

  async getProposal(proposalId: number): Promise<WebsiteChangeProposal | null> {
    await this.#approvalQueue.authorizeObservation({
      title: "Check a website change proposal",
      description: `Read the state of proposal ${proposalId}.`,
    });
    return this.#gatekeeper.getProposal(proposalId);
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class WebsiteGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<WebsiteSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "website://impactfinance.be",
      title: "IFB website",
      snippet: "Read the website source and propose changes for human review.",
      suggestedBindingName: "WEBSITE",
      tsType: "WebsiteSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<WebsiteSession> {
    return new WebsiteSessionImpl(approvalQueue.dup(), this, this.env);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  // --- proposal storage -------------------------------------------------------------

  async enqueueProposal(title: string, description: string, files: WebsiteFileChange[]): Promise<number> {
    const next = ((await this.ctx.storage.get<number>("proposal-counter")) ?? 0) + 1;
    await this.ctx.storage.put("proposal-counter", next);
    const record: StoredProposal = { proposalId: next, status: "pending", title, description, files };
    await this.ctx.storage.put(`proposal:${next}`, record);
    return next;
  }

  async getProposal(proposalId: number): Promise<WebsiteChangeProposal | null> {
    const record = await this.ctx.storage.get<StoredProposal>(`proposal:${proposalId}`);
    if (!record) return null;
    const { files: _files, description: _description, ...visible } = record;
    return visible;
  }

  // --- action lifecycle -------------------------------------------------------------

  async applyAction(action: number): Promise<void> {
    const key = `proposal:${action}`;
    const record = await this.ctx.storage.get<StoredProposal>(key);
    if (!record || record.status !== "pending" || !record.files) {
      throw new Error(`No pending proposal ${action}.`);
    }
    try {
      const repoMeta = (await githubApi(this.env, "")) as { default_branch: string };
      const base = repoMeta.default_branch;
      let branch = base;
      if (!DIRECT_TO_MAIN) {
        const headRef = (await githubApi(this.env, `/git/ref/heads/${base}`)) as { object: { sha: string } };
        branch = `os/${slugify(record.title)}-${headRef.object.sha.slice(0, 6)}`;
        await githubApi(this.env, "/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: headRef.object.sha });
      }

      let lastCommitSha = "";
      for (const file of record.files) {
        const clean = file.path.replace(/^\/+/, "");
        const existing = (await githubApi(
          this.env,
          `/contents/${encodeURI(clean)}?ref=${encodeURIComponent(branch)}`,
        )) as { sha?: string } | null;
        const put = (await githubApi(this.env, `/contents/${encodeURI(clean)}`, "PUT", {
          message: `${record.title}\n\n${record.description}\n\nApproved in Cloudflare OS.`,
          content: b64encodeUtf8(file.content),
          branch,
          ...(existing?.sha ? { sha: existing.sha } : {}),
        })) as { commit?: { sha?: string } };
        lastCommitSha = put.commit?.sha ?? lastCommitSha;
      }

      await this.ctx.storage.put(key, {
        ...record,
        files: undefined,
        status: "applied",
        branch,
        compareUrl: DIRECT_TO_MAIN
          ? `https://github.com/${this.env.WEBSITE_REPO}/commit/${lastCommitSha}`
          : `https://github.com/${this.env.WEBSITE_REPO}/compare/${base}...${encodeURIComponent(branch)}?expand=1`,
      } satisfies StoredProposal);
    } catch (error) {
      await this.ctx.storage.put(key, {
        ...record,
        files: undefined,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      } satisfies StoredProposal);
      throw error;
    }
  }

  async rejectAction(action: number): Promise<void> {
    const key = `proposal:${action}`;
    const record = await this.ctx.storage.get<StoredProposal>(key);
    if (record) {
      await this.ctx.storage.put(key, { ...record, files: undefined, status: "rejected" } satisfies StoredProposal);
    }
  }

  async revertAction(action: number): Promise<void> {
    const key = `proposal:${action}`;
    const record = await this.ctx.storage.get<StoredProposal>(key);
    if (!record?.branch || record.branch === "main" || DIRECT_TO_MAIN) {
      throw new Error("Direct-to-main changes are reverted with a new change, not from here.");
    }
    await githubApi(this.env, `/git/refs/heads/${encodeURIComponent(record.branch)}`, "DELETE");
    await this.ctx.storage.put(key, {
      ...record,
      status: "rejected",
      branch: undefined,
      compareUrl: undefined,
    } satisfies StoredProposal);
  }
}

@validateRpc()
export class WebsiteAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeWebsiteAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<WebsiteSession>>> {
    return this.ctx.exports.WebsiteGatekeeper({});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("The website gatekeeper has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The website gatekeeper has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("The website gatekeeper's credential is a deployment secret; rotate it with wrangler.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.WebsiteVerifier({});
  }
}

@validateRpc()
export class WebsiteVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeWebsiteVendor();
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.WebsiteAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("The website gatekeeper is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
