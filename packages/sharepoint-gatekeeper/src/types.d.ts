/** One file or folder in the IFB SharePoint document library. */
export interface SharePointEntry {
  name: string;
  /** Path relative to the document library root, e.g. "2 IFB Activities/Events". */
  path: string;
  type: "file" | "folder";
  size: number;
  lastModified: string;
  webUrl: string;
}

/**
 * Read-only access to IFB's SharePoint document library (the IFB site only; the
 * app's Sites.Selected grant makes every other site unreachable).
 */
export interface SharePointSession {
  /** List a folder. Empty path = document library root. */
  listFiles(path: string): Promise<SharePointEntry[]>;
  /** Search file names and content across the IFB document library. */
  searchFiles(term: string): Promise<SharePointEntry[]>;
  /** Read a small text file (UTF-8, max ~1MB). Office/binary files: use getDownloadUrl. */
  readTextFile(path: string): Promise<string>;
  /** Short-lived download URL for any file (for ingestion of Office/PDF documents). */
  getDownloadUrl(path: string): Promise<string>;
}
