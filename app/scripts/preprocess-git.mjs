/**
 * Scans every subdirectory of git_data/ (which must be a bare/cloned .git dir),
 * extracts the commit log, and writes one JSON file per repo into public/.
 *
 * Usage:
 *   npm run preprocess:git                   # process all repos
 *   node scripts/preprocess-git.mjs 300      # process all repos, 300 commits each
 *
 * Output: public/<repoName>_commits.json
 * Requires git to be installed on PATH.
 */

import { execSync } from "child_process";
import { writeFileSync, readdirSync, statSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const maxCount = parseInt(process.argv[2] ?? "4500", 10);
const gitDataDir = resolve(root, "git_data");
const outDir = resolve(root, "public");

const repos = readdirSync(gitDataDir).filter((name) =>
  statSync(join(gitDataDir, name)).isDirectory(),
);

if (repos.length === 0) {
  console.error(`No repos found in ${gitDataDir}`);
  process.exit(1);
}

const fmt = "%H\x1f%P\x1f%an\x1f%ai\x1f%s";

for (const repoName of repos) {
  const gitDir = join(gitDataDir, repoName);
  const outFile = join(outDir, `${repoName}_commits.json`);

  // ── 1. Get all branch ref tips using for-each-ref ────────────────────────
  const refTips = new Map(); // hash → branchName
  try {
    const refsRaw = execSync(
      `git --git-dir="${gitDir}" for-each-ref --format="%(objectname) %(refname:short)" refs/heads refs/remotes/origin`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    for (const line of refsRaw.trim().split("\n").filter(Boolean)) {
      const spaceIdx = line.indexOf(" ");
      const hash = line.slice(0, spaceIdx);
      const fullRef = line.slice(spaceIdx + 1);
      const name = fullRef.replace(/^origin\//, "");
      // Skip HEAD and prefer shorter names
      if (name === "HEAD" || name === "origin") continue;
      if (!refTips.has(hash) || name.length < refTips.get(hash).length) {
        refTips.set(hash, name);
      }
    }
  } catch (err) {
    console.warn(`⚠ Could not read refs for ${repoName}: ${err.message}`);
  }

  // ── 2. Load the full commit log ───────────────────────────────────────────
  let raw;
  try {
    raw = execSync(
      `git --git-dir="${gitDir}" log --all --topo-order --pretty=format:"${fmt}" --max-count=${maxCount}`,
      { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
    );
  } catch (err) {
    console.warn(`⚠ Skipping ${repoName}: ${err.message}`);
    continue;
  }

  const rows = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, parentsRaw, author, date, ...subjectParts] = line.split("\x1f");
      return {
        hash,
        parents: parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [],
        author,
        date,
        subject: subjectParts.join("\x1f"),
      };
    });

  const commitMap = new Map(rows.map((c) => [c.hash, c]));

  // ── 3. Assign a branch to every commit ────────────────────────────────────
  // Walk main's first-parent chain, labeling as main.
  // For merge commits, extract the feature branch name from the subject
  // and label the second parent's first-parent chain with that name.

  const branchOf = new Map(); // hash → branchName
  const isMainBranch = (name) => name === "main" || name === "master";

  // Find the main branch ref
  const mainRef = [...refTips.entries()].find(([, name]) => isMainBranch(name));
  const mainName = mainRef?.[1] ?? "main";
  const mainTip = mainRef?.[0] ?? rows[0]?.hash;

  // Helper to extract branch name from merge commit subject
  const parseMergeBranch = (subject) => {
    // "Merge branch 'feature-x'"
    const branchMatch = subject.match(/^Merge branch '([^']+)'/i);
    if (branchMatch) return branchMatch[1];

    // "Merge pull request #123 from user/feature-x"
    const prMatch = subject.match(/^Merge pull request #\d+ from (?:[^/]+\/)?(.+)$/i);
    if (prMatch) return prMatch[1].trim();

    return null;
  };

  // Generate a branch name from commit subject when no explicit name
  const generateBranchName = (subject) => {
    const s = subject.toLowerCase().trim();

    // Common conventional commit prefixes
    const prefixMatch = s.match(/^(fix|feat|feature|chore|docs|refactor|test|perf|ci|build)[\s:(]/);
    if (prefixMatch) {
      const prefix = prefixMatch[1];
      // Extract a short descriptor
      const rest = s.slice(prefix.length).replace(/^[\s:(\[]+/, '').split(/[\s,)\]]/)[0];
      if (rest && rest.length > 2 && rest.length < 20) {
        return `${prefix}/${rest}`;
      }
      return prefix;
    }

    // Extract first meaningful word
    const words = s.split(/\s+/).filter(w =>
      w.length > 3 && !/^(the|and|for|with|from|into|this|that|when|added|fixed|updated)$/i.test(w)
    );
    if (words[0]) {
      const word = words[0].replace(/[^a-z0-9-]/gi, '').slice(0, 15);
      if (word.length > 2) return `feature/${word}`;
    }

    return null;
  };

  // Label first-parent chain (stops at shared history)
  const labelFirstParentChain = (startHash, branchName) => {
    let hash = startHash;
    while (hash && commitMap.has(hash)) {
      if (branchOf.has(hash)) break;
      branchOf.set(hash, branchName);
      const c = commitMap.get(hash);
      hash = c.parents[0] ?? null;
    }
  };

  // Walk main's first-parent chain
  let hash = mainTip;
  while (hash && commitMap.has(hash)) {
    if (branchOf.has(hash)) break;
    branchOf.set(hash, mainName);
    const c = commitMap.get(hash);

    // For merge commits, label second parent chain as feature branch
    if (c.parents.length > 1) {
      const secondParent = c.parents[1];
      if (commitMap.has(secondParent) && !branchOf.has(secondParent)) {
        const secondCommit = commitMap.get(secondParent);
        const featureBranch = parseMergeBranch(c.subject) || generateBranchName(secondCommit.subject);
        if (featureBranch) {
          labelFirstParentChain(secondParent, featureBranch);
        }
      }
    }

    hash = c.parents[0] ?? null;
  }

  // Everything else is main
  for (const c of rows) {
    if (!branchOf.has(c.hash)) {
      branchOf.set(c.hash, mainName);
    }
  }

  // ── 4. Build final output ─────────────────────────────────────────────────
  const commits = rows.map((c) => {
    const branch = branchOf.get(c.hash) ?? null;
    const isMerge = c.parents.length > 1;

    const result = {
      hash: c.hash,
      parents: c.parents,
      author: c.author,
      date: c.date,
      subject: c.subject,
      branch,
    };

    if (isMerge) {
      // Try to derive a meaningful merge source name
      const secondParentBranch = branchOf.get(c.parents[1]) ?? null;
      const subjectBranch = c.subject.match(/^Merge branch '([^']+)'/i)?.[1] ?? null;
      const subjectPR =
        c.subject.match(/^Merge pull request #\d+ from (?:[^/]+\/)?(.+)$/i)?.[1]?.trim() ?? null;

      // Only use secondParentBranch if it differs from this commit's branch
      // (otherwise it's a useless self-reference)
      const mergeSource =
        (secondParentBranch && secondParentBranch !== branch ? secondParentBranch : null) ??
        subjectBranch ??
        subjectPR;
      if (mergeSource) result.merge = mergeSource;
    }

    return result;
  });

  writeFileSync(outFile, JSON.stringify(commits, null, 2));
  console.log(`✓ ${repoName} → ${commits.length} commits → public/${repoName}_commits.json`);
}
