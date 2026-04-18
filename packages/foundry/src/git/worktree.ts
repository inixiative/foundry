import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Git worktree utilities — read-only detection of existing worktrees
// ---------------------------------------------------------------------------
//
// Foundry doesn't create or destroy worktrees. The user manages them.
// These utilities detect what's available so threads can be assigned to one.
//
// Adapted from hivemind/src/git/getWorktrees.ts (async Bun.spawn, not execSync).
// ---------------------------------------------------------------------------

export interface GitWorktree {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name (null if detached HEAD). */
  branch: string | null;
  /** HEAD commit hash. */
  commit: string;
  /** Whether this is the main worktree (the original clone). */
  isMain: boolean;
}

// ---------------------------------------------------------------------------
// Git command runner
// ---------------------------------------------------------------------------

async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  return stdout.trim();
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return resolved;

  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Worktree listing
// ---------------------------------------------------------------------------

/** List all git worktrees for a repository. */
export async function listWorktrees(repoRoot: string): Promise<GitWorktree[]> {
  let output: string;
  try {
    output = await git(["worktree", "list", "--porcelain"], repoRoot);
  } catch {
    return [];
  }

  if (!output) return [];

  const worktrees: GitWorktree[] = [];
  let current: Partial<GitWorktree> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push(current as GitWorktree);
      }
      current = { path: line.slice(9), isMain: worktrees.length === 0 };
    } else if (line.startsWith("HEAD ")) {
      current.commit = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "detached") {
      current.branch = null;
    }
  }

  if (current.path) {
    worktrees.push(current as GitWorktree);
  }

  return worktrees;
}

// ---------------------------------------------------------------------------
// Finders
// ---------------------------------------------------------------------------

/** Find a worktree by branch name. */
export function findByBranch(
  worktrees: GitWorktree[],
  branch: string,
): GitWorktree | undefined {
  return worktrees.find((w) => w.branch === branch);
}

/** Find the worktree whose path contains the given directory. */
export function findByPath(
  worktrees: GitWorktree[],
  cwd: string,
): GitWorktree | undefined {
  const target = normalizePath(cwd);

  return [...worktrees]
    .sort((a, b) => b.path.length - a.path.length)
    .find((w) => {
      const root = normalizePath(w.path);
      return target === root || target.startsWith(`${root}${sep}`);
    });
}

// ---------------------------------------------------------------------------
// Branch utilities
// ---------------------------------------------------------------------------

/** Get the current branch name (null if detached). */
export async function getCurrentBranch(cwd?: string): Promise<string | null> {
  try {
    const branch = await git(["branch", "--show-current"], cwd);
    return branch || null;
  } catch {
    return null;
  }
}

/** Diff stat between two branches (for Herald cross-thread comparison). */
export async function diffStat(
  repoRoot: string,
  base: string,
  head: string,
): Promise<string> {
  return git(["diff", `${base}...${head}`, "--stat"], repoRoot);
}
