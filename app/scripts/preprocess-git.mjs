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

// ═══════════════════════════════════════════════════════════════════════════
// Git Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function runGit(gitDir, command) {
  return execSync(`git --git-dir="${gitDir}" ${command}`, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  }).trim();
}

function parseNumstat(numstatOutput) {
  const files = [];
  for (const line of numstatOutput.split("\n").filter(Boolean)) {
    const [add, del, ...pathParts] = line.split("\t");
    if (!del || !pathParts.length) continue;
    files.push({
      path: pathParts.join("\t"), // Handle paths with tabs
      additions: add === "-" ? 0 : parseInt(add, 10),
      deletions: del === "-" ? 0 : parseInt(del, 10),
    });
  }
  return files;
}

function extractMergeBranch(subject) {
  // "Merge branch 'feature-x'" or "Merge pull request #123 from user/feature-x"
  const patterns = [/^Merge branch '([^']+)'/i, /^Merge pull request #\d+ from (?:[^/]+\/)?(.+)$/i];

  for (const pattern of patterns) {
    const match = subject.match(pattern);
    if (match) return match[1].trim();
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Processing
// ═══════════════════════════════════════════════════════════════════════════

const repos = readdirSync(gitDataDir).filter((name) =>
  statSync(join(gitDataDir, name)).isDirectory(),
);

if (repos.length === 0) {
  console.error(`No repos found in ${gitDataDir}`);
  process.exit(1);
}

for (const repoName of repos) {
  const gitDir = join(gitDataDir, repoName);
  const outFile = join(outDir, `${repoName}_commits.json`);

  console.log(`\nProcessing ${repoName}...`);

  try {
    // ── Step 1: Get all commit hashes ──────────────────────────────────────
    const hashes = runGit(gitDir, `log --all --topo-order --format="%H" --max-count=${maxCount}`)
      .split("\n")
      .filter(Boolean);

    console.log(`  Found ${hashes.length} commits`);

    // ── Step 2: Get commit details ─────────────────────────────────────────
    const commits = [];
    const commitMap = new Map();

    for (let i = 0; i < hashes.length; i++) {
      const hash = hashes[i];

      if (i % 100 === 0) {
        console.log(`  Processing ${i + 1}/${hashes.length}...`);
      }

      try {
        // Get commit info: author, date, subject, parents
        const info = runGit(gitDir, `show --format="%an%x1f%ai%x1f%s%x1f%P" --quiet "${hash}"`);
        const [author, date, subject, parentsStr] = info.split("\x1f");
        const parents = parentsStr ? parentsStr.split(" ").filter(Boolean) : [];

        // Get files modified
        const numstat = runGit(gitDir, `show --format="" --numstat "${hash}"`);
        const files = parseNumstat(numstat);

        const commit = { hash, parents, author, date, subject, files };
        commits.push(commit);
        commitMap.set(hash, commit);
      } catch (err) {
        console.warn(`  ⚠ Skipping commit ${hash.slice(0, 7)}: ${err.message}`);
      }
    }

    console.log(`  Assigning branches...`);

    // ── Step 3: Assign branch names ────────────────────────────────────────
    // Detect main branch name from git refs
    let mainName = "main";
    try {
      const refs = runGit(
        gitDir,
        `for-each-ref --format="%(refname:short)" refs/heads/main refs/heads/master refs/remotes/origin/main refs/remotes/origin/master`,
      );
      const ref = refs.split("\n").filter(Boolean)[0];
      if (ref) {
        mainName = ref.replace(/^origin\//, "").replace(/^refs\/heads\//, "");
      }
    } catch (err) {
      // Default to "main" if detection fails
    }

    const branchOf = new Map();

    // Simple strategy: walk first-parent chains from main
    function assignBranch(startHash, branchName) {
      let hash = startHash;
      while (hash && commitMap.has(hash)) {
        if (branchOf.has(hash)) break; // Already assigned
        branchOf.set(hash, branchName);

        const commit = commitMap.get(hash);

        // For merges, assign branch to second parent chain
        if (commit.parents.length > 1) {
          const secondParent = commit.parents[1];
          const mergedBranch = extractMergeBranch(commit.subject);
          if (secondParent && mergedBranch && !branchOf.has(secondParent)) {
            assignBranch(secondParent, mergedBranch);
          }
        }

        hash = commit.parents[0]; // Follow first parent
      }
    }

    assignBranch(commits[0]?.hash, mainName);

    // For any remaining commits, try to infer their branch from merge commits
    // Don't just default everything to main!
    for (const commit of commits) {
      if (!branchOf.has(commit.hash)) {
        // Check if this commit is mentioned in a merge
        let foundBranch = null;

        for (const otherCommit of commits) {
          if (otherCommit.parents.length > 1 &&
              otherCommit.parents[1] === commit.hash) {
            // This commit is the second parent of a merge
            foundBranch = extractMergeBranch(otherCommit.subject);
            if (foundBranch) {
              assignBranch(commit.hash, foundBranch);
              break;
            }
          }
        }

        // If still not assigned, use a feature branch name
        if (!branchOf.has(commit.hash)) {
          const shortSubject = commit.subject
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .slice(0, 20);
          branchOf.set(commit.hash, shortSubject || `feature-${commit.hash.slice(0, 7)}`);
        }
      }
    }

    // ── Step 4: Build output with children ─────────────────────────────────
    // First, create the base output
    const output = commits.map((c) => ({
      hash: c.hash,
      parents: c.parents,
      children: [], // Will populate in next step
      author: c.author,
      date: c.date,
      subject: c.subject,
      branch: branchOf.get(c.hash) || null,
      merge: c.parents.length > 1 ? extractMergeBranch(c.subject) : undefined,
      files: c.files,
    }));

    // Build hash lookup
    const outputMap = new Map(output.map((c) => [c.hash, c]));

    // Populate children by inverting parent relationships
    for (const commit of output) {
      for (const parentHash of commit.parents) {
        const parent = outputMap.get(parentHash);
        if (parent) {
          parent.children.push(commit.hash);
        }
      }
    }

    // ── Step 5: Write output ───────────────────────────────────────────────
    writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.log(`  ✓ Wrote ${output.length} commits → public/${repoName}_commits.json`);
  } catch (err) {
    console.error(`  ✗ Failed to process ${repoName}: ${err.message}`);
  }
}

console.log("\n✅ Done!");
