const TYPES_CODE = `/** One file or directory entry in the website repository. */
export interface WebsiteEntry {
  path: string;
  type: "file" | "dir";
  size: number;
}

/** One file edit inside a change proposal. */
export interface WebsiteFileChange {
  /** Repo-relative path, e.g. "src/pages/about.astro". */
  path: string;
  /** Full new content of the file (UTF-8). */
  content: string;
}

/** A website change proposal and its lifecycle state. */
export interface WebsiteChangeProposal {
  proposalId: number;
  /** pending = waiting for human approval in the OS; applied = branch exists on GitHub. */
  status: "pending" | "applied" | "rejected" | "failed";
  title: string;
  /** Set once applied: the review branch name. */
  branch?: string;
  /** Set once applied: one-click "create pull request" URL for a human reviewer. */
  compareUrl?: string;
  /** Set when a proposal failed to apply. */
  error?: string;
}

/**
 * The IFB public website repository (impactfinance-belgium-website).
 *
 * Reading is free-form; writing ONLY happens as a change proposal: after human
 * approval it becomes a new branch with the edits, for review and merge on
 * GitHub. Nothing here can touch the main branch or deploy the site.
 */
export interface WebsiteSession {
  /** List a directory of the website repo (default branch). Empty path = repo root. */
  listFiles(dir: string): Promise<WebsiteEntry[]>;
  /** Read one file of the website repo (default branch, UTF-8, max ~1MB). */
  readFile(path: string): Promise<string>;
  /**
   * Propose a change (max 20 files, full new contents per file). Returns a pending
   * proposal; once a human approves it in the OS, the edits land on branch
   * \`os/<slug>\` and getProposal() reports the branch and compare URL.
   */
  proposeChange(title: string, description: string, files: WebsiteFileChange[]): Promise<WebsiteChangeProposal>;
  /** Fetch a proposal's current state by id. */
  getProposal(proposalId: number): Promise<WebsiteChangeProposal | null>;
}
`;

export default TYPES_CODE;
