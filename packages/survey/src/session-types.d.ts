/** A survey round, as staff see it in Cloudflare OS. */
export interface SurveyRoundInfo {
  id: string;
  label: string;
  instrumentVersion: string;
  status: string;
  questionCount: number;
}

/** Where one invited organisation stands. Never includes answer values. */
export interface SurveyInviteInfo {
  orgId: string;
  orgName: string;
  status: string;
  answered: number;
  total: number;
}

/** Round-level completion counts. */
export interface SurveyProgress {
  roundId: string;
  invited: number;
  started: number;
  submitted: number;
}

/** Aggregate for one question across all responding organisations. No per-org values. */
export interface SurveyQuestionAggregate {
  code: string;
  section: string;
  label: string;
  qtype: string;
  /** Organisations that answered this question (beyond an untouched pre-fill). */
  respondents: number;
  /** select/multiselect: option -> count. */
  optionCounts?: Record<string, number>;
  /** number: aggregate stats. */
  sum?: number;
  mean?: number;
  /** text: counted only; content never crosses the gatekeeper. */
  textAnswers?: number;
}

/**
 * Read-only view of IFB's market survey.
 *
 * Confidentiality rule enforced in code, not convention: per-organisation ANSWER
 * VALUES are never exposed here. Staff see who was invited, who started, who
 * submitted, and how much is filled in. The answers themselves stay in the survey
 * application, where per-organisation AUM belongs.
 */
export interface SurveySession {
  /** Every survey round with its instrument version and question count. */
  listRounds(): Promise<SurveyRoundInfo[]>;
  /** Invited/started/submitted counts for one round. */
  roundProgress(roundId: string): Promise<SurveyProgress>;
  /** Per-organisation status and completion for one round. No answer values. */
  listInvites(roundId: string): Promise<SurveyInviteInfo[]>;
  /**
   * Aggregated results for one round: option counts, numeric sums/means, text counts.
   * Aggregation happens inside the survey worker; per-organisation values never cross
   * this boundary. A minimum-respondents suppression threshold is a pending policy
   * decision for IFB; the demo round runs without one.
   */
  roundResults(roundId: string): Promise<SurveyQuestionAggregate[]>;
}
