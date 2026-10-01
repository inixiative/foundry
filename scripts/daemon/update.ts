/**
 * Auto-update with two copies of the code. The daemon never runs the working
 * checkout: it runs a release, an exported commit with its own install under
 * <config>/releases/<sha>. An update builds origin/main as the candidate; the
 * next boot runs it on trial, and a boot that completes makes it stable. A
 * candidate that fails to boot is marked failed, never retried, and the
 * relaunch runs stable. Only stable and the release before it are kept.
 */

import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';

export type AutoUpdate = 'off' | 'check' | 'apply';

/** Distinct from a crash so the logs can tell the two apart. */
export const RESTART_EXIT_CODE = 75;

export interface ReleaseState {
  stable?: string;
  previous?: string;
  candidate?: string;
  /** Set while a candidate boots; still set on the next launch means that boot died. */
  booting?: string;
  failed: string[];
}

export interface Release {
  sha: string;
  dir: string;
  trial: boolean;
}

export interface UpdateResult {
  action: 'none' | 'reported' | 'staged' | 'skipped' | 'failed';
  target?: string;
  detail?: string;
}

/** Makes an exported commit runnable. */
export type PrepareRelease = (dir: string) => Promise<void>;

const READY_MARKER = '.release-ready';
const KEEP_FAILED = 20;

const releasesRoot = (configDir: string) => join(configDir, 'releases');
const statePath = (configDir: string) => join(releasesRoot(configDir), 'state.json');
export const releaseDir = (configDir: string, sha: string) => join(releasesRoot(configDir), sha);

export const readAutoUpdate = async (configDir: string): Promise<AutoUpdate> => {
  try {
    const value = (await Bun.file(join(configDir, 'settings.json')).json())?.daemon?.autoUpdate;
    return value === 'check' || value === 'apply' ? value : 'off';
  } catch {
    return 'off';
  }
};

export const readState = async (configDir: string): Promise<ReleaseState> => {
  try {
    return { failed: [], ...(await Bun.file(statePath(configDir)).json()) };
  } catch {
    return { failed: [] };
  }
};

const writeState = async (configDir: string, state: ReleaseState) => {
  await mkdir(releasesRoot(configDir), { recursive: true });
  await Bun.write(statePath(configDir), JSON.stringify(state, null, 2));
};

const prune = async (configDir: string, state: ReleaseState) => {
  const keep = new Set([state.stable, state.previous, state.candidate].filter(Boolean));
  for (const entry of await readdir(releasesRoot(configDir)))
    if (entry !== 'state.json' && !keep.has(entry))
      await rm(join(releasesRoot(configDir), entry), { recursive: true, force: true });
};

export const installRelease: PrepareRelease = async (dir) => {
  await $`bun install --frozen-lockfile`.cwd(dir).quiet();
  await $`bunx prisma generate`.cwd(dir).quiet();
};

/** Exports a commit and prepares it; a build that fails leaves no release behind. */
export const buildRelease = async (
  repoRoot: string,
  configDir: string,
  sha: string,
  prepare = installRelease,
): Promise<string> => {
  const dir = releaseDir(configDir, sha);
  if (await Bun.file(join(dir, READY_MARKER)).exists()) return dir;
  const staging = `${dir}.building`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await $`git -C ${repoRoot} archive ${sha} | tar -x -C ${staging}`.quiet();
    await prepare(staging);
    await Bun.write(join(staging, READY_MARKER), sha);
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
    return dir;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
};

/** Marks a candidate failed and drops it, so the next boot runs stable. */
export const rejectCandidate = async (configDir: string, sha: string): Promise<void> => {
  const state = await readState(configDir);
  state.failed = [...state.failed.filter((failed) => failed !== sha), sha].slice(-KEEP_FAILED);
  if (state.candidate === sha) state.candidate = undefined;
  if (state.booting === sha) state.booting = undefined;
  await writeState(configDir, state);
  await prune(configDir, state);
};

/**
 * Builds origin/<branch> as the candidate when it is new, has not failed
 * before, and autoUpdate is "apply".
 */
export const stageUpdate = async (
  repoRoot: string,
  configDir: string,
  branch = 'main',
  prepare = installRelease,
): Promise<UpdateResult> => {
  try {
    await $`git -C ${repoRoot} fetch --quiet origin ${branch}`.quiet();
  } catch (error) {
    return { action: 'failed', detail: `fetch failed: ${String(error)}` };
  }
  const target = (await $`git -C ${repoRoot} rev-parse origin/${branch}`.quiet().text()).trim();
  const state = await readState(configDir);
  if (target === state.stable || target === state.candidate) return { action: 'none', target };
  if (state.failed.includes(target))
    return { action: 'skipped', target, detail: 'it failed to boot before' };
  if ((await readAutoUpdate(configDir)) !== 'apply') return { action: 'reported', target };
  try {
    await buildRelease(repoRoot, configDir, target, prepare);
  } catch (error) {
    return { action: 'failed', target, detail: `build failed: ${String(error)}` };
  }
  const current = await readState(configDir);
  current.candidate = target;
  await writeState(configDir, current);
  await prune(configDir, current);
  return { action: 'staged', target };
};

/**
 * The release to boot: the candidate on trial, else stable. A candidate whose
 * previous boot never completed is rejected first. The first run seeds stable
 * from the checkout's HEAD.
 */
export const selectRelease = async (
  repoRoot: string,
  configDir: string,
  prepare = installRelease,
): Promise<Release> => {
  let state = await readState(configDir);
  if (state.candidate && state.booting === state.candidate) {
    await rejectCandidate(configDir, state.candidate);
    state = await readState(configDir);
  }
  if (state.candidate) {
    state.booting = state.candidate;
    await writeState(configDir, state);
    return { sha: state.candidate, dir: releaseDir(configDir, state.candidate), trial: true };
  }
  const stable = state.stable ?? (await $`git -C ${repoRoot} rev-parse HEAD`.quiet().text()).trim();
  const dir = await buildRelease(repoRoot, configDir, stable, prepare);
  if (state.stable !== stable) {
    state.stable = stable;
    await writeState(configDir, state);
  }
  return { sha: stable, dir, trial: false };
};

/** A completed boot: a trial candidate becomes stable and the old stable is kept as previous. */
export const recordBoot = async (configDir: string, release: Release): Promise<void> => {
  if (!release.trial) return;
  const state = await readState(configDir);
  if (state.candidate !== release.sha) return;
  state.previous = state.stable;
  state.stable = release.sha;
  state.candidate = undefined;
  state.booting = undefined;
  await writeState(configDir, state);
  await prune(configDir, state);
};
