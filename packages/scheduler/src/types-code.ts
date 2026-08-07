const TYPES_CODE = `/** One entry of IFB's git-defined scheduled job table (secrets never included). */
export interface SchedulerJobInfo {
  id: string;
  description: string;
  cron: string;
  enabled: boolean;
  method: string;
  url: string;
  /** Name of the secret header the job sends, or null. Values never leave the worker. */
  usesSecretHeader: string | null;
}

/** Read-only view of IFB's scheduled jobs. */
export interface SchedulerSession {
  /** List every job in the git-defined table, enabled or not. */
  listJobs(): Promise<SchedulerJobInfo[]>;
}
`;

export default TYPES_CODE;
