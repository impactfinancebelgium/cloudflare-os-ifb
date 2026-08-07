// The survey's face inside Cloudflare OS: a read-only vendor card so staff can ask
// "who has responded to the market survey?" from the OS, and agents can answer.
//
// Confidentiality is the design constraint here. Per-organisation answers (AUM above
// all) must not leave the survey application, so this gatekeeper exposes only
// participation state: rounds, counts, and per-organisation status plus how many
// questions are filled in. There is deliberately no method that returns an answer
// value, and no write methods at all: invites are minted by IFB staff tooling
// against the admin API, not from an agent session.

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
  SurveyInviteInfo,
  SurveyProgress,
  SurveyQuestionAggregate,
  SurveyRoundInfo,
  SurveySession,
} from "./session-types.js";
import TYPES_CODE from "./types-code.js";

const SURVEY_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='20'>" +
      "<path d='M60 36h136v184H60z'/><path d='M92 92h72M92 128h72M92 164h40'/></svg>",
    ),
};

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> &
  Partial<{ [Symbol.dispose](): void }>;

export function describeSurveyVendor(): VendorDescription {
  return {
    displayName: "Market survey (IFB)",
    url: "https://github.com/impactfinancebelgium/cloudflare-os-ifb",
    logo: SURVEY_ICON,
    color: "#eef3f7",
    tagline: "Who has responded to IFB's market survey",
    description:
      "Read-only view of the market survey: rounds, invited organisations, and how far each has got. " +
      "Per-organisation answers stay in the survey application and are never exposed here.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeSurveyAccount(): AccountDescription {
  return {
    displayName: "Market survey (IFB)",
    avatar: SURVEY_ICON,
    singleton: { tsType: "SurveySession" },
  };
}

@validateRpc()
export class SurveySessionImpl extends RpcTarget implements SurveySession {
  readonly #approvalQueue: ObservationQueue;
  readonly #db: D1Database;

  constructor(approvalQueue: ObservationQueue, db: D1Database) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#db = db;
  }

  async listRounds(): Promise<SurveyRoundInfo[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "List survey rounds",
      description: "Read the market survey's rounds and question counts. No answers.",
    });
    const rs = await this.#db.prepare(
      `SELECT r.id, r.label, r.instrument_version, r.status,
              (SELECT count(*) FROM survey_question q WHERE q.round_id = r.id) AS questions
       FROM survey_round r ORDER BY r.id`,
    ).all();
    return (rs.results as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      label: r.label as string,
      instrumentVersion: r.instrument_version as string,
      status: r.status as string,
      questionCount: Number(r.questions ?? 0),
    }));
  }

  async roundProgress(roundId: string): Promise<SurveyProgress> {
    await this.#approvalQueue.authorizeObservation({
      title: "Read survey progress",
      description: `Read invited/started/submitted counts for round ${roundId}. No answers.`,
    });
    const row = await this.#db.prepare(
      `SELECT
         (SELECT count(*) FROM survey_invite WHERE round_id = ?1) AS invited,
         (SELECT count(*) FROM survey_invite WHERE round_id = ?1 AND status = 'started') AS started,
         (SELECT count(*) FROM survey_invite WHERE round_id = ?1 AND status = 'submitted') AS submitted`,
    ).bind(roundId).first<{ invited: number; started: number; submitted: number }>();
    return {
      roundId,
      invited: Number(row?.invited ?? 0),
      started: Number(row?.started ?? 0),
      submitted: Number(row?.submitted ?? 0),
    };
  }

  async listInvites(roundId: string): Promise<SurveyInviteInfo[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "List survey participants",
      description:
        `Read per-organisation status and completion for round ${roundId}. ` +
        "Counts only: no answer values are returned.",
    });
    // Deliberately count(*) over answers rather than selecting any value.
    const rs = await this.#db.prepare(
      `SELECT i.org_id, o.name,  i.status,
              (SELECT count(*) FROM survey_answer a
                WHERE a.round_id = i.round_id AND a.org_id = i.org_id
                  AND a.source != 'prefilled') AS answered,
              (SELECT count(*) FROM survey_question q WHERE q.round_id = i.round_id) AS total
       FROM survey_invite i LEFT JOIN survey_org o ON o.id = i.org_id
       WHERE i.round_id = ?1 ORDER BY o.name`,
    ).bind(roundId).all();
    return (rs.results as Record<string, unknown>[]).map((r) => ({
      orgId: r.org_id as string,
      orgName: (r.name as string) ?? (r.org_id as string),
      status: r.status as string,
      answered: Number(r.answered ?? 0),
      total: Number(r.total ?? 0),
    }));
  }

  async roundResults(roundId: string): Promise<SurveyQuestionAggregate[]> {
    await this.#approvalQueue.authorizeObservation({
      title: "Read aggregated survey results",
      description:
        `Aggregate results for round ${roundId}: option counts, numeric sums and means, ` +
        "text-answer counts. Per-organisation values never leave the survey application.",
    });
    const qs = await this.#db.prepare(
      `SELECT code, section, label, qtype FROM survey_question
       WHERE round_id = ?1 ORDER BY position`,
    ).bind(roundId).all();
    // Confirmed answers only: an untouched pre-fill is not evidence of a response.
    const as = await this.#db.prepare(
      `SELECT code, value FROM survey_answer
       WHERE round_id = ?1 AND source != 'prefilled'`,
    ).bind(roundId).all();
    const byCode = new Map<string, unknown[]>();
    for (const r of as.results as { code: string; value: string | null }[]) {
      if (r.value == null) continue;
      const list = byCode.get(r.code) ?? [];
      try { list.push(JSON.parse(r.value)); } catch { continue; }
      byCode.set(r.code, list);
    }
    const out: SurveyQuestionAggregate[] = [];
    for (const q of qs.results as { code: string; section: string; label: string; qtype: string }[]) {
      const values = byCode.get(q.code) ?? [];
      if (!values.length) continue;
      const agg: SurveyQuestionAggregate = {
        code: q.code, section: q.section, label: q.label, qtype: q.qtype,
        respondents: values.length,
      };
      if (q.qtype === "select" || q.qtype === "multiselect") {
        const counts: Record<string, number> = {};
        for (const v of values) {
          for (const opt of Array.isArray(v) ? v : [v]) {
            const key = String(opt);
            counts[key] = (counts[key] ?? 0) + 1;
          }
        }
        agg.optionCounts = counts;
      } else if (q.qtype === "number") {
        const nums = values.map(Number).filter((n) => Number.isFinite(n));
        if (nums.length) {
          agg.sum = nums.reduce((a, b) => a + b, 0);
          agg.mean = agg.sum / nums.length;
        }
      } else {
        // Text stays inside the survey app: expose only that answers exist.
        agg.textAnswers = values.length;
      }
      out.push(agg);
    }
    return out;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class SurveyGatekeeper extends DurableObject<Cloudflare.Env>
  implements Gatekeeper<SurveySession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "survey://ifb-os-survey",
      title: "Market survey (IFB)",
      snippet: "Read-only participation view of IFB's market survey. No answer values.",
      suggestedBindingName: "SURVEY",
      tsType: "SurveySession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SurveySession> {
    return new SurveySessionImpl(approvalQueue.dup(), (this.env as { DB: D1Database }).DB);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    throw new Error(`The survey gatekeeper is read-only and has no actions (${action}).`);
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<void> {
    throw new Error("The survey gatekeeper has no actions to revert.");
  }
}

@validateRpc()
export class SurveyAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeSurveyAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<SurveySession>>> {
    return this.ctx.exports.SurveyGatekeeper({});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("The survey gatekeeper has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The survey gatekeeper has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("The survey gatekeeper has no credentials to reconnect.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SurveyVerifier({});
  }
}

@validateRpc()
export class SurveyVerifier extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeSurveyVendor();
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.SurveyAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("The survey gatekeeper is auto-provisioned and has no connect flow.");
  }
}
