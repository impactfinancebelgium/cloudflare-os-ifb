// The scheduler's face inside Cloudflare OS: a read-only gatekeeper so the job
// table is visible as a vendor card at os.impactfinance.be and agents can answer
// "what runs when". The jobs themselves are defined in git (jobs.ts) and executed
// by the scheduled handler in index.ts; nothing here can create, enable, or run a
// job. Changing the schedule stays a reviewed git change.

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
import { JOBS } from "./jobs.js";
import type { SchedulerJobInfo, SchedulerSession } from "./session-types.js";
import TYPES_CODE from "./types-code.js";

const SCHEDULER_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='20'><circle cx='128' cy='128' r='88'/><path d='M128 76v52l36 24'/></svg>",
    ),
};

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> &
  Partial<{ [Symbol.dispose](): void }>;

export function describeSchedulerVendor(): VendorDescription {
  return {
    displayName: "Scheduled jobs (IFB)",
    url: "https://github.com/impactfinancebelgium/cloudflare-os-ifb",
    logo: SCHEDULER_ICON,
    color: "#f2f7ee",
    tagline: "IFB's cron job table, defined in git",
    description:
      "Read-only view of IFB's scheduled jobs (heartbeats, syncs). Jobs are defined and reviewed in git; this card is the window, not the editor.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeSchedulerAccount(): AccountDescription {
  return {
    displayName: "Scheduled jobs (IFB)",
    avatar: SCHEDULER_ICON,
    singleton: { tsType: "SchedulerSession" },
  };
}

// Secrets never leave the worker: expose the header NAME a job uses, not values.
function toJobInfo(job: (typeof JOBS)[number]): SchedulerJobInfo {
  return {
    id: job.id,
    description: job.description,
    cron: job.cron,
    enabled: job.enabled,
    method: job.action.method ?? "GET",
    url: job.action.url,
    usesSecretHeader: job.action.secretHeader?.[0] ?? null,
  };
}

@validateRpc()
export class SchedulerSessionImpl extends RpcTarget implements SchedulerSession {
  readonly #approvalQueue: ObservationQueue;

  constructor(approvalQueue: ObservationQueue) {
    super();
    this.#approvalQueue = approvalQueue;
  }

  async listJobs(): Promise<SchedulerJobInfo[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "List scheduled jobs",
      description: "Read the git-defined scheduled job table (ids, crons, targets; no secrets).",
    });
    return JOBS.map(toJobInfo);
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class SchedulerGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<SchedulerSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "scheduler://ifb-os-scheduler",
      title: "Scheduled jobs (IFB)",
      snippet: "Read-only view of IFB's git-defined cron job table.",
      suggestedBindingName: "SCHEDULER",
      tsType: "SchedulerSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SchedulerSession> {
    return new SchedulerSessionImpl(approvalQueue.dup());
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    throw new Error(`The scheduler gatekeeper is read-only and has no actions (${action}).`);
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<void> {
    throw new Error("The scheduler gatekeeper has no actions to revert.");
  }
}

@validateRpc()
export class SchedulerAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeSchedulerAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<SchedulerSession>>> {
    return this.ctx.exports.SchedulerGatekeeper({});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("The scheduler gatekeeper has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The scheduler gatekeeper has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("The scheduler gatekeeper has no credentials to reconnect.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SchedulerVerifier({});
  }
}

@validateRpc()
export class SchedulerVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeSchedulerVendor();
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.SchedulerAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("The scheduler gatekeeper is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
