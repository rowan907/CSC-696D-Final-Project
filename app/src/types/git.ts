export interface CommitFile {
  additions: number;
  deletions: number;
  path: string;
}

export interface Commit {
  hash: string;
  parents: Commit[];
  children: Commit[];
  author: string;
  date: string;
  subject: string;
  branch: string | null;
  merge?: string | null;
  files?: CommitFile[];
}
