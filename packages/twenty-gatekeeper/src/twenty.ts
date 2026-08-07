// IFB Twenty CRM Gatekeeper: read-only search and lookup against the self-hosted
// Twenty at crm.impactfinance.be, which sits behind Cloudflare Access. The worker
// authenticates with an Access service token (ifb-os-twenty) plus the Twenty API key,
// both held here as Worker secrets: agents never see credentials, only results, and
// every call is recorded as an observation in the approval queue. No write methods
// exist in this class by design; adding one is a deliberate future decision.

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
import type { TwentyCompany, TwentyPerson, TwentySession } from "./types.js";
import TYPES_CODE from "./types-code.js";

const TWENTY_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='20'><rect x='40' y='40' width='176' height='176' rx='24'/><path d='M92 104h72M92 104c20 0 36 16 36 36v36'/></svg>",
    ),
};

const MAX_LIMIT = 25;

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> &
  Partial<{ [Symbol.dispose](): void }>;

export function describeTwentyVendor(): VendorDescription {
  return {
    displayName: "Twenty CRM (IFB)",
    url: "https://crm.impactfinance.be",
    logo: TWENTY_ICON,
    color: "#eef3ff",
    tagline: "Read-only access to IFB's CRM",
    description:
      "Search and read people and companies in IFB's Twenty CRM. Read-only: the CRM stays human-edited.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeTwentyAccount(): AccountDescription {
  return {
    displayName: "Twenty CRM (IFB)",
    avatar: TWENTY_ICON,
    singleton: { tsType: "TwentySession" },
  };
}

// Twenty REST record shapes (the subset we read).
type RawPerson = {
  id: string;
  name?: { firstName?: string; lastName?: string };
  emails?: { primaryEmail?: string };
  jobTitle?: string;
  companyId?: string | null;
  city?: string;
  linkedinLink?: { primaryLinkUrl?: string };
};
type RawCompany = {
  id: string;
  name?: string;
  domainName?: { primaryLinkUrl?: string };
  linkedinLink?: { primaryLinkUrl?: string };
  address?: { addressCity?: string };
  employees?: number | null;
};

function toPerson(base: string, r: RawPerson): TwentyPerson {
  return {
    id: r.id,
    firstName: r.name?.firstName ?? "",
    lastName: r.name?.lastName ?? "",
    email: r.emails?.primaryEmail ?? "",
    jobTitle: r.jobTitle ?? "",
    companyId: r.companyId ?? null,
    city: r.city ?? "",
    linkedinUrl: r.linkedinLink?.primaryLinkUrl ?? "",
    url: `${base}/object/person/${r.id}`,
  };
}

function toCompany(base: string, r: RawCompany): TwentyCompany {
  return {
    id: r.id,
    name: r.name ?? "",
    domainName: r.domainName?.primaryLinkUrl ?? "",
    linkedinUrl: r.linkedinLink?.primaryLinkUrl ?? "",
    city: r.address?.addressCity ?? "",
    employees: r.employees ?? null,
    url: `${base}/object/company/${r.id}`,
  };
}

// The %-wildcards around the term make ilike a substring match; strip characters
// that would break Twenty's filter grammar rather than trying to escape them.
function ilikeTerm(term: string): string {
  return `%${term.replace(/[%(),:]/g, "")}%`;
}

@validateRpc()
export class TwentySessionImpl extends RpcTarget implements TwentySession {
  readonly #approvalQueue: ObservationQueue;
  readonly #env: Cloudflare.Env;

  constructor(approvalQueue: ObservationQueue, env: Cloudflare.Env) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#env = env;
  }

  async #get(path: string): Promise<unknown> {
    const response = await fetch(`${this.#env.TWENTY_BASE_URL}${path}`, {
      headers: {
        "CF-Access-Client-Id": this.#env.CF_ACCESS_CLIENT_ID ?? "",
        "CF-Access-Client-Secret": this.#env.CF_ACCESS_CLIENT_SECRET ?? "",
        authorization: `Bearer ${this.#env.TWENTY_API_KEY ?? ""}`,
        "user-agent": "ifb-os-twenty-gatekeeper",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`Twenty CRM request failed (${response.status}).`);
    }
    return response.json();
  }

  async searchPeople(term: string, limit = 10): Promise<TwentyPerson[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "Search people in Twenty CRM",
      description: `Search CRM people matching "${term}".`,
    });
    const t = encodeURIComponent(ilikeTerm(term));
    const filter = encodeURIComponent("or(") +
      `name.firstName[ilike]:${t},name.lastName[ilike]:${t},emails.primaryEmail[ilike]:${t}` +
      encodeURIComponent(")");
    const body = (await this.#get(
      `/rest/people?limit=${Math.min(limit, MAX_LIMIT)}&filter=${filter}`,
    )) as { data?: { people?: RawPerson[] } };
    return (body.data?.people ?? []).map((r) => toPerson(this.#env.TWENTY_BASE_URL, r));
  }

  async searchCompanies(term: string, limit = 10): Promise<TwentyCompany[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "Search companies in Twenty CRM",
      description: `Search CRM companies matching "${term}".`,
    });
    const t = encodeURIComponent(ilikeTerm(term));
    const filter = encodeURIComponent("or(") +
      `name[ilike]:${t},domainName.primaryLinkUrl[ilike]:${t}` +
      encodeURIComponent(")");
    const body = (await this.#get(
      `/rest/companies?limit=${Math.min(limit, MAX_LIMIT)}&filter=${filter}`,
    )) as { data?: { companies?: RawCompany[] } };
    return (body.data?.companies ?? []).map((r) => toCompany(this.#env.TWENTY_BASE_URL, r));
  }

  async getPerson(id: string): Promise<TwentyPerson | null> {
    await this.#approvalQueue.authorizeObservation({
      title: "Read a person from Twenty CRM",
      description: `Read CRM person ${id}.`,
    });
    try {
      const body = (await this.#get(`/rest/people/${encodeURIComponent(id)}`)) as {
        data?: { person?: RawPerson };
      };
      return body.data?.person ? toPerson(this.#env.TWENTY_BASE_URL, body.data.person) : null;
    } catch {
      return null;
    }
  }

  async getCompany(id: string): Promise<TwentyCompany | null> {
    await this.#approvalQueue.authorizeObservation({
      title: "Read a company from Twenty CRM",
      description: `Read CRM company ${id}.`,
    });
    try {
      const body = (await this.#get(`/rest/companies/${encodeURIComponent(id)}`)) as {
        data?: { company?: RawCompany };
      };
      return body.data?.company ? toCompany(this.#env.TWENTY_BASE_URL, body.data.company) : null;
    } catch {
      return null;
    }
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class TwentyGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<TwentySession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "twenty://crm.impactfinance.be",
      title: "Twenty CRM (IFB)",
      snippet: "Read-only search and lookup of IFB's CRM people and companies.",
      suggestedBindingName: "TWENTY",
      tsType: "TwentySession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<TwentySession> {
    return new TwentySessionImpl(approvalQueue.dup(), this.env);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    throw new Error(`Twenty Gatekeeper is read-only and has no actions (${action}).`);
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<void> {
    throw new Error("Twenty Gatekeeper has no actions to revert.");
  }
}

@validateRpc()
export class TwentyAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeTwentyAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<TwentySession>>> {
    return this.ctx.exports.TwentyGatekeeper({});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Twenty Gatekeeper has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Twenty Gatekeeper has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Twenty Gatekeeper's credentials are deployment secrets; rotate them with wrangler.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.TwentyVerifier({});
  }
}

@validateRpc()
export class TwentyVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeTwentyVendor();
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.TwentyAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Twenty Gatekeeper is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
