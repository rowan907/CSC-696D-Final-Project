export interface CommitFile {
  status: string; // M, A, D, R, C, etc.
  path: string;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  branch: string | null;
  merge?: string | null;
  files?: CommitFile[];
}
