// IFB SharePoint Gatekeeper: read-only access to the IFB site's document library
// from Cloudflare OS, via Microsoft Graph client credentials (the "IFB Workspace"
// Entra app). The app permission is Sites.Selected granted on the IFB site ONLY,
// so CEO/Finance and every other site answer 403 regardless of what this code
// asks for; that confinement was verified when the app was set up. Every call is
// recorded as an observation; there are no write methods.

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
import type { SharePointEntry, SharePointSession } from "./types.js";
import TYPES_CODE from "./types-code.js";

const SP_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='20'><path d='M48 76a24 24 0 0 1 24-24h56l24 24h56a24 24 0 0 1 24 24v80a24 24 0 0 1-24 24H72a24 24 0 0 1-24-24z'/></svg>",
    ),
};

const MAX_TEXT_BYTES = 1_000_000;

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> &
  Partial<{ [Symbol.dispose](): void }>;

export function describeSharePointVendor(): VendorDescription {
  return {
    displayName: "SharePoint (IFB)",
    url: "https://impactfinancebelgium.sharepoint.com",
    logo: SP_ICON,
    color: "#eef4fb",
    tagline: "Read-only access to IFB's documents",
    description:
      "Search, browse and read the IFB SharePoint document library. Read-only, and confined to the IFB site by the app's Sites.Selected grant.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeSharePointAccount(): AccountDescription {
  return {
    displayName: "SharePoint (IFB)",
    avatar: SP_ICON,
    singleton: { tsType: "SharePointSession" },
  };
}

// App-only token, cached per isolate until shortly before expiry.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getToken(env: Cloudflare.Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET ?? "",
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const response = await fetch(
    `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", body, signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) throw new Error(`Microsoft sign-in failed (${response.status}).`);
  const json = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

type DriveItem = {
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  folder?: unknown;
  parentReference?: { path?: string };
  "@microsoft.graph.downloadUrl"?: string;
};

function toEntry(item: DriveItem): SharePointEntry {
  // parentReference.path looks like "/drives/<id>/root:/2 IFB Activities".
  const parent = (item.parentReference?.path ?? "").split("root:")[1] ?? "";
  const path = `${parent}/${item.name ?? ""}`.replace(/^\/+/, "");
  return {
    name: item.name ?? "",
    path,
    type: item.folder ? "folder" : "file",
    size: item.size ?? 0,
    lastModified: item.lastModifiedDateTime ?? "",
    webUrl: item.webUrl ?? "",
  };
}

@validateRpc()
export class SharePointSessionImpl extends RpcTarget implements SharePointSession {
  readonly #approvalQueue: ObservationQueue;
  readonly #env: Cloudflare.Env;

  constructor(approvalQueue: ObservationQueue, env: Cloudflare.Env) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#env = env;
  }

  async #graph(path: string): Promise<unknown> {
    const token = await getToken(this.#env);
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${this.#env.SP_SITE_ID}${path}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`SharePoint request failed (${response.status}).`);
    return response.json();
  }

  #itemPath(path: string): string {
    const clean = path.replace(/^\/+|\/+$/g, "");
    return clean ? `/drive/root:/${encodeURI(clean)}:` : "/drive/root";
  }

  async listFiles(path: string): Promise<SharePointEntry[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "List SharePoint folder",
      description: `List "${path || "/"}" in the IFB document library.`,
    });
    const suffix = path.replace(/^\/+|\/+$/g, "")
      ? `${this.#itemPath(path)}/children`
      : "/drive/root/children";
    const body = (await this.#graph(suffix)) as { value?: DriveItem[] };
    return (body.value ?? []).map(toEntry);
  }

  async searchFiles(term: string): Promise<SharePointEntry[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "Search SharePoint",
      description: `Search the IFB document library for "${term}".`,
    });
    const body = (await this.#graph(
      `/drive/root/search(q='${encodeURIComponent(term.replace(/'/g, ""))}')`,
    )) as { value?: DriveItem[] };
    return (body.value ?? []).map(toEntry);
  }

  async readTextFile(path: string): Promise<string> {
    await this.#approvalQueue.authorizeObservation({
      title: "Read a SharePoint file",
      description: `Read "${path}" from the IFB document library.`,
    });
    const meta = (await this.#graph(this.#itemPath(path))) as DriveItem;
    if (meta.folder) throw new Error("Path is a folder, not a file.");
    if ((meta.size ?? 0) > MAX_TEXT_BYTES) throw new Error("File is too large to read as text.");
    const url = meta["@microsoft.graph.downloadUrl"];
    if (!url) throw new Error("File has no downloadable content.");
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    return response.text();
  }

  async getDownloadUrl(path: string): Promise<string> {
    await this.#approvalQueue.authorizeObservation({
      title: "Get a SharePoint download link",
      description: `Create a short-lived download link for "${path}".`,
    });
    const meta = (await this.#graph(this.#itemPath(path))) as DriveItem;
    const url = meta["@microsoft.graph.downloadUrl"];
    if (!url) throw new Error("Path has no downloadable content (is it a folder?).");
    return url;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class SharePointGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<SharePointSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "sharepoint://impactfinancebelgium/ifb",
      title: "SharePoint (IFB)",
      snippet: "Read-only search and reading of the IFB document library.",
      suggestedBindingName: "SHAREPOINT",
      tsType: "SharePointSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SharePointSession> {
    return new SharePointSessionImpl(approvalQueue.dup(), this.env);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    throw new Error(`The SharePoint gatekeeper is read-only and has no actions (${action}).`);
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<void> {
    throw new Error("The SharePoint gatekeeper has no actions to revert.");
  }
}

@validateRpc()
export class SharePointAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeSharePointAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<SharePointSession>>> {
    return this.ctx.exports.SharePointGatekeeper({});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("The SharePoint gatekeeper has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The SharePoint gatekeeper has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("The SharePoint gatekeeper's credential is a deployment secret; rotate it with wrangler.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SharePointVerifier({});
  }
}

@validateRpc()
export class SharePointVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeSharePointVendor();
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.SharePointAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("The SharePoint gatekeeper is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
