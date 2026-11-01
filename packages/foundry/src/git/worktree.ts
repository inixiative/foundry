/**
 * @atlas
 * @kind helper
 * @partOf infrastructure:git
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Git worktree utilities — read-only detection of existing worktrees
// ---------------------------------------------------------------------------
//
// Detection of existing worktrees so threads can be assigned to one, and recreating a released
// worktree with the project's own worktree mode (FEAT-003). Foundry never destroys a worktree.
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
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
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
    output = await git(['worktree', 'list', '--porcelain'], repoRoot);
  } catch {
    return [];
  }

  if (!output) return [];

  const worktrees: GitWorktree[] = [];
  let current: Partial<GitWorktree> = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) {
        worktrees.push(current as GitWorktree);
      }
      current = { path: line.slice(9), isMain: worktrees.length === 0 };
    } else if (line.startsWith('HEAD ')) {
      current.commit = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'detached') {
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
export function findByBranch(worktrees: GitWorktree[], branch: string): GitWorktree | undefined {
  return worktrees.find((w) => w.branch === branch);
}

/** The entry whose path is, or most closely contains, the given directory. */
export function containingPath<T extends { path: string }>(
  entries: Iterable<T>,
  cwd: string,
): T | undefined {
  const target = normalizePath(cwd);

  return [...entries]
    .sort((a, b) => b.path.length - a.path.length)
    .find((entry) => {
      const root = normalizePath(entry.path);
      return target === root || target.startsWith(`${root}${sep}`);
    });
}

/** Find the worktree whose path contains the given directory. */
export function findByPath(worktrees: GitWorktree[], cwd: string): GitWorktree | undefined {
  return containingPath(worktrees, cwd);
}

// ---------------------------------------------------------------------------
// Branch utilities
// ---------------------------------------------------------------------------

/** Get the current branch name (null if detached). */
export async function getCurrentBranch(cwd?: string): Promise<string | null> {
  try {
    const branch = await git(['branch', '--show-current'], cwd);
    return branch || null;
  } catch {
    return null;
  }
}

/** Origin remote URL, checked-out branch and worktree root of the checkout containing `cwd`. */
export async function gitContext(
  cwd: string,
): Promise<{ remote?: string; branch?: string; worktree?: string }> {
  const read = (args: string[]) => git(args, cwd).catch(() => '');
  const [remote, branch, worktree] = await Promise.all([
    read(['remote', 'get-url', 'origin']),
    getCurrentBranch(cwd),
    read(['rev-parse', '--show-toplevel']),
  ]);
  return {
    ...(remote ? { remote } : {}),
    ...(branch ? { branch } : {}),
    ...(worktree ? { worktree } : {}),
  };
}

/**
 * How a project makes worktrees (FEAT-003): `template` when its main checkout's `package.json` has a
 * `worktree:create` script (slots: databases, ports, buckets), else `classic` (plain `git worktree`).
 */
export type WorktreeMode = 'template' | 'classic';

/** The worktree mode of the repository whose main checkout is `mainRoot`. */
export function worktreeMode(mainRoot: string): WorktreeMode {
  try {
    const pkg = JSON.parse(readFileSync(join(mainRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    return typeof pkg.scripts?.['worktree:create'] === 'string' ? 'template' : 'classic';
  } catch {
    return 'classic';
  }
}

/**
 * The template slot a worktree holds: `WORKTREE_SLOT` in its `.env.local`, else `.env.test`, read
 * the way template's `worktree:list` reads it. Only that one key is read.
 */
export function worktreeSlot(worktreeRoot: string): number | undefined {
  for (const file of ['.env.local', '.env.test']) {
    let text: string;
    try {
      text = readFileSync(join(worktreeRoot, file), 'utf8');
    } catch {
      continue;
    }
    const value = text.match(
      /^\s*(?:export\s+)?WORKTREE_SLOT\s*=\s*["']?(\d+)["']?\s*(?:#.*)?$/m,
    )?.[1];
    if (value !== undefined) return Number(value);
  }
  return undefined;
}

/** Where a checkout sits among its repository's worktrees, and how that repository makes them. */
export interface CheckoutPlace {
  mode: WorktreeMode;
  /** Root of the worktree containing the directory. */
  path: string;
  /** The repository's main checkout, where the mode's commands run. */
  root: string;
  /** The repository's main checkout (the original clone), not a linked worktree. */
  main: boolean;
  /** Template mode: the slot it holds (the main checkout is slot 0). */
  slot?: number;
}

/** The checkout containing `cwd`: its worktree root, whether it is the main one, mode and slot. */
export async function checkoutPlace(cwd: string): Promise<CheckoutPlace | undefined> {
  const worktrees = await listWorktrees(cwd);
  const own = findByPath(worktrees, cwd);
  const mainRoot = worktrees.find((w) => w.isMain)?.path;
  if (!own || !mainRoot) return undefined;
  const mode = worktreeMode(mainRoot);
  const slot = mode === 'template' ? (own.isMain ? 0 : worktreeSlot(own.path)) : undefined;
  return {
    mode,
    path: own.path,
    root: mainRoot,
    main: own.isMain,
    ...(slot === undefined ? {} : { slot }),
  };
}

/**
 * The default branch `branch` was squash-merged into, by tree equality (CLAUDE.md § Merging: patch
 * counts lie after squash): the branch has commits the base lacks, and merging it into the base
 * changes nothing. Reads the local remote-tracking refs as last fetched; never fetches.
 */
export async function squashMergedInto(cwd: string, branch: string): Promise<string | undefined> {
  const base = await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], cwd).catch(() => '');
  if (!base || base === `origin/${branch}`) return undefined;
  const ahead = Number(
    await git(['rev-list', '--count', `${base}..${branch}`], cwd).catch(() => '0'),
  );
  if (!(ahead > 0)) return undefined;
  const [merged, baseTree] = await Promise.all([
    git(['merge-tree', '--write-tree', base, branch], cwd).catch(() => ''),
    git(['rev-parse', `${base}^{tree}`], cwd).catch(() => ''),
  ]);
  return merged && baseTree && merged.split('\n')[0] === baseTree
    ? base.replace(/^origin\//, '')
    : undefined;
}

/**
 * Release a worktree with the repository's worktree mode (FEAT-003 "destroy"): template runs
 * `bun run worktree:destroy <name>` (frees its slot), classic `git worktree remove <path>`. Never
 * `--force`: both refuse a dirty worktree, and the refusal is returned.
 */
export async function releaseWorktree(place: {
  mode: WorktreeMode;
  root: string;
  path: string;
}): Promise<{ released: true } | { error: string }> {
  const command =
    place.mode === 'template'
      ? ['bun', 'run', 'worktree:destroy', place.path.split(sep).pop() ?? '']
      : ['git', 'worktree', 'remove', place.path];
  const proc = Bun.spawn(command, { cwd: place.root, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return code === 0
    ? { released: true }
    : {
        error: `${command.slice(0, 3).join(' ')} refused (exit ${code}): ${`${err}\n${out}`.trim().slice(-600)}`,
      };
}

/**
 * Create a worktree again on an existing branch with the repository's worktree mode (FEAT-003
 * "recreate"): template runs `bun run worktree:create <branch>` (a fresh slot and setup, at
 * `<root>/.worktrees/<branch with / as ->`); classic runs `git worktree add <path> <branch>`.
 * Never `--force`. Returns the new worktree's root, or the command's failure.
 */
export async function recreateWorktree(
  place: { mode: WorktreeMode; root: string; path: string },
  branch: string,
): Promise<{ path: string } | { error: string }> {
  const command =
    place.mode === 'template'
      ? ['bun', 'run', 'worktree:create', branch]
      : ['git', 'worktree', 'add', place.path, branch];
  const proc = Bun.spawn(command, { cwd: place.root, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    return {
      error: `${command.slice(0, 3).join(' ')} failed (exit ${code}): ${`${err}\n${out}`.trim().slice(-600)}`,
    };
  const path =
    place.mode === 'template'
      ? findByBranch(await listWorktrees(place.root), branch)?.path
      : place.path;
  return path ? { path } : { error: `no worktree holds ${branch} after create` };
}

export interface BranchCommit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  /** Commit time, epoch ms. */
  at: number;
}

/**
 * Commits on the checkout containing `cwd` that its base doesn't have (`base..HEAD`), newest first.
 * The base is the origin's default branch (`origin/HEAD`), else `main`. Read-only.
 */
export async function branchCommits(
  cwd: string,
  limit = 50,
): Promise<{ base: string; commits: BranchCommit[] }> {
  const base = await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], cwd).catch(() => 'main');
  const out = await git(
    ['log', `--max-count=${limit}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct', `${base}..HEAD`],
    cwd,
  ).catch(() => '');
  const commits = out
    ? out.split('\n').map((line) => {
        const [sha = '', short = '', subject = '', author = '', at = '0'] = line.split('\x1f');
        return { sha, short, subject, author, at: Number(at) * 1000 };
      })
    : [];
  return { base, commits };
}

/** Diff stat between two branches (for Herald cross-thread comparison). */
export async function diffStat(repoRoot: string, base: string, head: string): Promise<string> {
  return git(['diff', `${base}...${head}`, '--stat'], repoRoot);
}
