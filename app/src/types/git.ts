export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  branch: string | null;
  merge?: string | null;
}
