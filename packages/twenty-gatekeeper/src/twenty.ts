// IFB Twenty CRM Gatekeeper: search, read AND edit the self-hosted Twenty at
// crm.impactfinance.be from Cloudflare OS. The worker authenticates with an Access
// service token (ifb-os-twenty) plus the Twenty API key, both Worker secrets:
// agents never see credentials, only results. Reads are recorded observations.
// EVERY write (updatePerson, updateCompany, createNote) is an approval-queue
// action: a human approves it in the OS before applyAction() writes to the CRM,
// fields are whitelisted, previous values are captured so updates can be
// reverted, and a created note reverts by deletion.

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
  TwentyCompany,
  TwentyCompanyEdit,
  TwentyEditResult,
  TwentyPerson,
  TwentyPersonEdit,
  TwentySession,
} from "./types.js";
import TYPES_CODE from "./types-code.js";

const TWENTY_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='20'><rect x='40' y='40' width='176' height='176' rx='24'/><path d='M92 104h72M92 104c20 0 36 16 36 36v36'/></svg>",
    ),
};

const MAX_LIMIT = 25;

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation" | "submitAction"> &
  Partial<{ [Symbol.dispose](): void }>;

// One queued write. `payload` is the Twenty PATCH/POST body; `previous` holds the
// pre-edit values of the touched fields (updates only) so revert can restore them.
type StoredEdit = TwentyEditResult & {
  kind: "update-person" | "update-company" | "create-note";
  recordId: string;
  payload?: Record<string, unknown>;
  previous?: Record<string, unknown>;
  noteTarget?: { key: "targetPersonId" | "targetCompanyId"; id: string };
  createdNoteId?: string;
};

export function describeTwentyVendor(): VendorDescription {
  return {
    displayName: "Twenty CRM (IFB)",
    url: "https://crm.impactfinance.be",
    logo: TWENTY_ICON,
    color: "#eef3ff",
    tagline: "Search, read and edit IFB's CRM",
    description:
      "Search and read people and companies in IFB's Twenty CRM, and edit them: every change is approved by a human in the OS before it is written.",
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
  newsletterSubscribed?: boolean;
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

// Flat edit fields -> Twenty PATCH payload + the fields to snapshot for revert.
function personPayload(fields: TwentyPersonEdit): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (fields.firstName !== undefined || fields.lastName !== undefined) {
    p.name = {
      ...(fields.firstName !== undefined ? { firstName: fields.firstName } : {}),
      ...(fields.lastName !== undefined ? { lastName: fields.lastName } : {}),
    };
  }
  if (fields.email !== undefined) p.emails = { primaryEmail: fields.email };
  if (fields.jobTitle !== undefined) p.jobTitle = fields.jobTitle;
  if (fields.city !== undefined) p.city = fields.city;
  if (fields.linkedinUrl !== undefined) p.linkedinLink = { primaryLinkUrl: fields.linkedinUrl };
  if (fields.companyId !== undefined) p.companyId = fields.companyId;
  if (fields.newsletterSubscribed !== undefined) p.newsletterSubscribed = fields.newsletterSubscribed;
  return p;
}

function companyPayload(fields: TwentyCompanyEdit): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (fields.name !== undefined) p.name = fields.name;
  if (fields.domainName !== undefined) p.domainName = { primaryLinkUrl: fields.domainName };
  if (fields.linkedinUrl !== undefined) p.linkedinLink = { primaryLinkUrl: fields.linkedinUrl };
  if (fields.city !== undefined) p.address = { addressCity: fields.city };
  if (fields.employees !== undefined) p.employees = fields.employees;
  return p;
}

function rejectUnknownFields(fields: object, allowed: string[]): void {
  const unknown = Object.keys(fields).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new Error(`Unknown or non-editable field(s): ${unknown.join(", ")}.`);
  }
}

async function twentyApi(
  env: Cloudflare.Env,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${env.TWENTY_BASE_URL}${path}`, {
    method,
    headers: {
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID ?? "",
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET ?? "",
      authorization: `Bearer ${env.TWENTY_API_KEY ?? ""}`,
      "user-agent": "ifb-os-twenty-gatekeeper",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Twenty CRM request failed (${response.status} on ${method} ${path}).`);
  }
  return response.json();
}

@validateRpc()
export class TwentySessionImpl extends RpcTarget implements TwentySession {
  readonly #approvalQueue: ObservationQueue;
  readonly #gatekeeper: TwentyGatekeeper;
  readonly #env: Cloudflare.Env;

  constructor(approvalQueue: ObservationQueue, gatekeeper: TwentyGatekeeper, env: Cloudflare.Env) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#gatekeeper = gatekeeper;
    this.#env = env;
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
    const body = (await twentyApi(
      this.#env,
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
    const body = (await twentyApi(
      this.#env,
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
      const body = (await twentyApi(this.#env, `/rest/people/${encodeURIComponent(id)}`)) as {
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
      const body = (await twentyApi(this.#env, `/rest/companies/${encodeURIComponent(id)}`)) as {
        data?: { company?: RawCompany };
      };
      return body.data?.company ? toCompany(this.#env.TWENTY_BASE_URL, body.data.company) : null;
    } catch {
      return null;
    }
  }

  async #queueEdit(edit: Omit<StoredEdit, "editId" | "status">, actionTitle: string, detail: string): Promise<TwentyEditResult> {
    const editId = await this.#gatekeeper.enqueueEdit(edit);
    await this.#approvalQueue.submitAction(editId, {
      title: actionTitle,
      description: detail,
      implementsRevert: true,
      // CRM reads don't reflect a pending edit, so the agent should wait for the verdict.
      awaitDecision: true,
    });
    return { editId, status: "pending", summary: edit.summary };
  }

  async updatePerson(id: string, fields: TwentyPersonEdit): Promise<TwentyEditResult> {
    rejectUnknownFields(fields, [
      "firstName", "lastName", "email", "jobTitle", "city", "linkedinUrl", "companyId", "newsletterSubscribed",
    ]);
    const payload = personPayload(fields);
    if (!Object.keys(payload).length) throw new Error("No editable fields given.");
    // Snapshot current values for the approval description and for revert.
    const current = (await twentyApi(this.#env, `/rest/people/${encodeURIComponent(id)}`)) as {
      data?: { person?: RawPerson & Record<string, unknown> };
    };
    const person = current.data?.person;
    if (!person) throw new Error(`No CRM person with id ${id}.`);
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(payload)) previous[key] = person[key] ?? null;
    const who = `${person.name?.firstName ?? ""} ${person.name?.lastName ?? ""}`.trim() || id;
    const summary = `Update person ${who}: ${Object.keys(fields).join(", ")}`;
    return this.#queueEdit(
      { kind: "update-person", recordId: id, payload, previous, summary },
      `CRM edit: ${who}`,
      `${summary}\n\nNew values: \`${JSON.stringify(fields)}\`\nPrevious: \`${JSON.stringify(previous)}\``,
    );
  }

  async updateCompany(id: string, fields: TwentyCompanyEdit): Promise<TwentyEditResult> {
    rejectUnknownFields(fields, ["name", "domainName", "linkedinUrl", "city", "employees"]);
    const payload = companyPayload(fields);
    if (!Object.keys(payload).length) throw new Error("No editable fields given.");
    const current = (await twentyApi(this.#env, `/rest/companies/${encodeURIComponent(id)}`)) as {
      data?: { company?: RawCompany & Record<string, unknown> };
    };
    const company = current.data?.company;
    if (!company) throw new Error(`No CRM company with id ${id}.`);
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(payload)) previous[key] = company[key] ?? null;
    const who = company.name || id;
    const summary = `Update company ${who}: ${Object.keys(fields).join(", ")}`;
    return this.#queueEdit(
      { kind: "update-company", recordId: id, payload, previous, summary },
      `CRM edit: ${who}`,
      `${summary}\n\nNew values: \`${JSON.stringify(fields)}\`\nPrevious: \`${JSON.stringify(previous)}\``,
    );
  }

  async createNote(
    target: "person" | "company",
    targetId: string,
    title: string,
    bodyMarkdown: string,
  ): Promise<TwentyEditResult> {
    if (target !== "person" && target !== "company") throw new Error("target must be person or company.");
    if (!title.trim()) throw new Error("A note needs a title.");
    const summary = `Note "${title}" on ${target} ${targetId}`;
    return this.#queueEdit(
      {
        kind: "create-note",
        recordId: targetId,
        payload: { title, bodyV2: { markdown: bodyMarkdown } },
        noteTarget: { key: target === "person" ? "targetPersonId" : "targetCompanyId", id: targetId },
        summary,
      },
      `CRM note: ${title}`,
      `Create a note titled "${title}" on ${target} ${targetId}.\n\n${bodyMarkdown}`,
    );
  }

  async getEdit(editId: number): Promise<TwentyEditResult | null> {
    await this.#approvalQueue.authorizeObservation({
      title: "Check a CRM edit",
      description: `Read the state of CRM edit ${editId}.`,
    });
    return this.#gatekeeper.getEdit(editId);
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
      snippet: "Search, read and edit IFB's CRM (edits need human approval).",
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
    return new TwentySessionImpl(approvalQueue.dup(), this, this.env);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  // --- edit storage -----------------------------------------------------------------

  async enqueueEdit(edit: Omit<StoredEdit, "editId" | "status">): Promise<number> {
    const next = ((await this.ctx.storage.get<number>("edit-counter")) ?? 0) + 1;
    await this.ctx.storage.put("edit-counter", next);
    await this.ctx.storage.put(`edit:${next}`, { ...edit, editId: next, status: "pending" });
    return next;
  }

  async getEdit(editId: number): Promise<TwentyEditResult | null> {
    const record = await this.ctx.storage.get<StoredEdit>(`edit:${editId}`);
    if (!record) return null;
    return { editId: record.editId, status: record.status, summary: record.summary, error: record.error };
  }

  // --- action lifecycle -------------------------------------------------------------

  async applyAction(action: number): Promise<void> {
    const key = `edit:${action}`;
    const record = await this.ctx.storage.get<StoredEdit>(key);
    if (!record || record.status !== "pending") throw new Error(`No pending CRM edit ${action}.`);
    try {
      if (record.kind === "update-person") {
        await twentyApi(this.env, `/rest/people/${encodeURIComponent(record.recordId)}`, "PATCH", record.payload);
      } else if (record.kind === "update-company") {
        await twentyApi(this.env, `/rest/companies/${encodeURIComponent(record.recordId)}`, "PATCH", record.payload);
      } else {
        const created = (await twentyApi(this.env, "/rest/notes", "POST", record.payload)) as {
          data?: { createNote?: { id?: string } };
        };
        const noteId = created.data?.createNote?.id;
        if (!noteId) throw new Error("Note creation returned no id.");
        record.createdNoteId = noteId;
        await twentyApi(this.env, "/rest/noteTargets", "POST", {
          noteId,
          [record.noteTarget!.key]: record.noteTarget!.id,
        });
      }
      await this.ctx.storage.put(key, { ...record, status: "applied" } satisfies StoredEdit);
    } catch (error) {
      await this.ctx.storage.put(key, {
        ...record,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      } satisfies StoredEdit);
      throw error;
    }
  }

  async rejectAction(action: number): Promise<void> {
    const key = `edit:${action}`;
    const record = await this.ctx.storage.get<StoredEdit>(key);
    if (record && record.status === "pending") {
      await this.ctx.storage.put(key, { ...record, status: "rejected" } satisfies StoredEdit);
    }
  }

  async revertAction(action: number): Promise<void> {
    const key = `edit:${action}`;
    const record = await this.ctx.storage.get<StoredEdit>(key);
    if (!record || record.status !== "applied") throw new Error(`CRM edit ${action} is not applied.`);
    if (record.kind === "create-note") {
      if (record.createdNoteId) {
        await twentyApi(this.env, `/rest/notes/${encodeURIComponent(record.createdNoteId)}`, "DELETE");
      }
    } else if (record.previous) {
      const path = record.kind === "update-person"
        ? `/rest/people/${encodeURIComponent(record.recordId)}`
        : `/rest/companies/${encodeURIComponent(record.recordId)}`;
      await twentyApi(this.env, path, "PATCH", record.previous);
    }
    await this.ctx.storage.put(key, { ...record, status: "rejected" } satisfies StoredEdit);
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
