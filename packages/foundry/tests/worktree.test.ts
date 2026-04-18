import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffStat,
  findByBranch,
  findByPath,
  getCurrentBranch,
  listWorktrees,
} from "../src/git/worktree";

const decoder = new TextDecoder();

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = decoder.decode(proc.stdout).trim();
  const stderr = decoder.decode(proc.stderr).trim();
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${proc.exitCode}): ${stderr}`);
  }

  return stdout;
}

describe("git/worktree utilities", () => {
  let tempRoot: string;
  let repoRoot: string;
  let featureRoot: string;
  let detachedRoot: string;
  let canonicalRepoRoot: string;
  let canonicalFeatureRoot: string;
  let canonicalDetachedRoot: string;
  let initialCommit: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "foundry-worktree-"));
    repoRoot = join(tempRoot, "repo");
    featureRoot = join(tempRoot, "repo-feature-auth");
    detachedRoot = join(tempRoot, "repo-detached");

    mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, ["init"]);
    git(repoRoot, ["config", "user.name", "Foundry Test"]);
    git(repoRoot, ["config", "user.email", "foundry@example.com"]);
    git(repoRoot, ["checkout", "-b", "main"]);

    writeFileSync(join(repoRoot, "README.md"), "hello from main\n");
    git(repoRoot, ["add", "README.md"]);
    git(repoRoot, ["commit", "-m", "initial"]);
    initialCommit = git(repoRoot, ["rev-parse", "HEAD"]);

    git(repoRoot, ["branch", "feature-auth"]);
    git(repoRoot, ["worktree", "add", featureRoot, "feature-auth"]);
    git(repoRoot, ["worktree", "add", "--detach", detachedRoot, "HEAD"]);

    canonicalRepoRoot = realpathSync.native(repoRoot);
    canonicalFeatureRoot = realpathSync.native(featureRoot);
    canonicalDetachedRoot = realpathSync.native(detachedRoot);

    writeFileSync(join(featureRoot, "feature.txt"), "feature branch change\n");
    git(featureRoot, ["add", "feature.txt"]);
    git(featureRoot, ["commit", "-m", "feature change"]);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("listWorktrees returns an empty list outside a git repo", async () => {
    const plainDir = join(tempRoot, "plain-dir");
    mkdirSync(plainDir, { recursive: true });

    await expect(listWorktrees(plainDir)).resolves.toEqual([]);
  });

  test("listWorktrees parses main, branch worktrees, and detached heads", async () => {
    const worktrees = await listWorktrees(repoRoot);
    expect(worktrees).toHaveLength(3);

    const main = worktrees.find((w) => w.path === repoRoot);
    const canonicalMain = worktrees.find((w) => w.path === canonicalRepoRoot);
    expect(main ?? canonicalMain).toBeDefined();
    expect((main ?? canonicalMain)!.branch).toBe("main");
    expect((main ?? canonicalMain)!.commit).toBe(initialCommit);
    expect((main ?? canonicalMain)!.isMain).toBe(true);

    const feature = worktrees.find((w) => w.path === canonicalFeatureRoot);
    expect(feature).toBeDefined();
    expect(feature!.branch).toBe("feature-auth");
    expect(feature!.isMain).toBe(false);

    const detached = worktrees.find((w) => w.path === canonicalDetachedRoot);
    expect(detached).toBeDefined();
    expect(detached!.branch).toBeNull();
    expect(detached!.isMain).toBe(false);
  });

  test("findByBranch locates a named worktree branch", async () => {
    const worktrees = await listWorktrees(repoRoot);
    const feature = findByBranch(worktrees, "feature-auth");

    expect(feature).toBeDefined();
    expect(feature!.path).toBe(canonicalFeatureRoot);
  });

  test("findByPath matches by path boundary instead of raw prefix", async () => {
    const worktrees = await listWorktrees(repoRoot);
    const nestedFeatureDir = join(featureRoot, "src", "nested");
    mkdirSync(nestedFeatureDir, { recursive: true });

    const match = findByPath(worktrees, nestedFeatureDir);
    expect(match).toBeDefined();
    expect(match!.path).toBe(canonicalFeatureRoot);
  });

  test("getCurrentBranch returns null for detached worktrees", async () => {
    await expect(getCurrentBranch(repoRoot)).resolves.toBe("main");
    await expect(getCurrentBranch(featureRoot)).resolves.toBe("feature-auth");
    await expect(getCurrentBranch(detachedRoot)).resolves.toBeNull();
  });

  test("diffStat reports branch-level changes between worktrees", async () => {
    const stat = await diffStat(repoRoot, "main", "feature-auth");

    expect(stat).toContain("feature.txt");
    expect(stat).toContain("1 file changed");
  });
});
