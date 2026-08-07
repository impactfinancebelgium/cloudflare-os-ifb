/** A person record from the IFB Twenty CRM, trimmed to the fields agents need. */
export interface TwentyPerson {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle: string;
  companyId: string | null;
  city: string;
  linkedinUrl: string;
  url: string;
}

/** A company record from the IFB Twenty CRM, trimmed to the fields agents need. */
export interface TwentyCompany {
  id: string;
  name: string;
  domainName: string;
  linkedinUrl: string;
  city: string;
  employees: number | null;
  url: string;
}

/** Editable person fields (whitelist; anything else is rejected). */
export interface TwentyPersonEdit {
  firstName?: string;
  lastName?: string;
  email?: string;
  jobTitle?: string;
  city?: string;
  linkedinUrl?: string;
  companyId?: string | null;
  newsletterSubscribed?: boolean;
}

/** Editable company fields (whitelist; anything else is rejected). */
export interface TwentyCompanyEdit {
  name?: string;
  domainName?: string;
  linkedinUrl?: string;
  city?: string;
  employees?: number | null;
}

/** A queued CRM edit and its lifecycle state. */
export interface TwentyEditResult {
  editId: number;
  /** pending = waiting for human approval in the OS; applied = written to the CRM. */
  status: "pending" | "applied" | "rejected" | "failed";
  summary: string;
  error?: string;
}

/**
 * IFB's Twenty CRM (crm.impactfinance.be). Reads are free-form; every edit is an
 * approval-queue action: a human approves it in the OS before it is written.
 */
export interface TwentySession {
  /** Search people by name or primary email (case-insensitive substring). */
  searchPeople(term: string, limit?: number): Promise<TwentyPerson[]>;
  /** Search companies by name or domain (case-insensitive substring). */
  searchCompanies(term: string, limit?: number): Promise<TwentyCompany[]>;
  /** Fetch one person by id. */
  getPerson(id: string): Promise<TwentyPerson | null>;
  /** Fetch one company by id. */
  getCompany(id: string): Promise<TwentyCompany | null>;
  /** Queue a person update for approval. Only whitelisted fields are accepted. */
  updatePerson(id: string, fields: TwentyPersonEdit): Promise<TwentyEditResult>;
  /** Queue a company update for approval. Only whitelisted fields are accepted. */
  updateCompany(id: string, fields: TwentyCompanyEdit): Promise<TwentyEditResult>;
  /** Queue creating a note on a person or company for approval. Body is Markdown. */
  createNote(target: "person" | "company", targetId: string, title: string, bodyMarkdown: string): Promise<TwentyEditResult>;
  /** Fetch an edit's current state by id. */
  getEdit(editId: number): Promise<TwentyEditResult | null>;
}
