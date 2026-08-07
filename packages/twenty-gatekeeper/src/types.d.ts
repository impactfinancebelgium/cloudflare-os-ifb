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

/** Read-only access to the IFB Twenty CRM (crm.impactfinance.be). */
export interface TwentySession {
  /** Search people by name or primary email (case-insensitive substring). */
  searchPeople(term: string, limit?: number): Promise<TwentyPerson[]>;
  /** Search companies by name or domain (case-insensitive substring). */
  searchCompanies(term: string, limit?: number): Promise<TwentyCompany[]>;
  /** Fetch one person by id. */
  getPerson(id: string): Promise<TwentyPerson | null>;
  /** Fetch one company by id. */
  getCompany(id: string): Promise<TwentyCompany | null>;
}
