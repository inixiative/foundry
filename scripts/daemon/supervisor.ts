#!/usr/bin/env bun
/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:daemon
 */
/**
 * Daemon entrypoint. Stages an update before launching, then boots a release (see
 * update.ts) and keeps watching, because a daemon left running for days would
 * otherwise never see main move. The watcher comes from the booted release, so a
 * change to how updates restart ships with the release instead of waiting for this
 * checkout to move: a staged update spins the daemon down (running turns finish,
 * new ones wait) and it restarts when the last one finishes (watch.ts,
 * packages/foundry/src/daemon/restart-roll.ts). Local services come up first. A candidate
 * that fails to boot (it throws, or is still booting at the boot deadline) falls back to
 * stable; a stable boot that fails on changed settings restores the last settings that booted.
 */
import { recordBooted, restoreAfterFailedBoot } from './last-good';
import { ensureServices } from './services';
import {
  MAX_INTERRUPTED_BOOTS,
  recordBoot,
  rejectCandidate,
  selectRelease,
  stageUpdate,
} from './update';
import { startUpdateWatcher as checkoutWatcher } from './watch';

const repoRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const configDir = `${repoRoot}/.foundry`;

const log = (message: string) => console.log(`[${new Date().toISOString()}] daemon: ${message}`);

const readSettings = async () => {
  try {
    return await Bun.file(`${repoRoot}/.foundry/settings.json`).json();
  } catch {
    return undefined;
  }
};

const short = (sha?: string) => sha?.slice(0, 8);
const update = await stageUpdate(repoRoot, configDir);
if (update.action === 'staged') log(`staged origin/main ${short(update.target)} as the candidate`);
if (update.action === 'reported')
  log(`origin/main is at ${short(update.target)} (autoUpdate is not "apply")`);
if (update.action === 'skipped') log(`not staging ${short(update.target)}: ${update.detail}`);
if (update.action === 'failed') log(`update skipped — ${update.detail}`);

const services = await ensureServices(repoRoot);
if (services.started.length) log(`services up: ${services.started.join(', ')}`);
if (services.detail) log(`services not started — ${services.detail}`);

const release = await selectRelease(repoRoot, configDir);
if (release.interruptedBoots)
  log(
    `candidate ${short(release.sha)}'s last boot was cut off before it finished; trying again (${release.interruptedBoots + 1} of ${MAX_INTERRUPTED_BOOTS})`,
  );

// The release's own watcher when it has one (it speaks to the daemon it ships with); this checkout's otherwise.
const releaseWatcher = `${release.dir}/scripts/daemon/watch.ts`;
const loadReleaseWatcher = async (): Promise<typeof checkoutWatcher> => {
  if (!(await Bun.file(releaseWatcher).exists())) return checkoutWatcher;
  try {
    const loaded = (await import(releaseWatcher)) as {
      startUpdateWatcher?: typeof checkoutWatcher;
    };
    return loaded.startUpdateWatcher ?? checkoutWatcher;
  } catch (error) {
    // A release whose watcher won't load still boots, watched by this checkout's.
    log(`release watcher did not load, using the checkout's — ${String(error)}`);
    return checkoutWatcher;
  }
};
const startUpdateWatcher = await loadReleaseWatcher();
const settings = await readSettings();
const checkSeconds = Number(settings?.daemon?.updateCheckSeconds ?? 300);
const spinDownSeconds = Number(settings?.daemon?.drainTimeoutSeconds);
// Generous: a boot took 19 minutes at load 90–200 (2026-11-04).
const bootTimeoutSeconds = Number(settings?.daemon?.bootTimeoutSeconds ?? 3600);
if (Number.isSafeInteger(checkSeconds) && checkSeconds >= 30)
  startUpdateWatcher({
    repoRoot,
    configDir,
    intervalMs: checkSeconds * 1000,
    ...(Number.isSafeInteger(spinDownSeconds) && spinDownSeconds >= 0
      ? { drainTimeoutMs: spinDownSeconds * 1000 }
      : {}),
    log,
  });
log(
  `starting ${release.trial ? 'candidate' : 'stable'} ${short(release.sha)} on port ${process.env.VIEWER_PORT ?? '4500'}`,
);
// A candidate still booting at the deadline is a failed boot; stable has nothing to fall back to.
const bootDeadline =
  release.trial && Number.isSafeInteger(bootTimeoutSeconds) && bootTimeoutSeconds > 0
    ? setTimeout(async () => {
        await rejectCandidate(configDir, release.sha);
        log(
          `candidate ${short(release.sha)} was still booting after ${bootTimeoutSeconds}s; marked failed, relaunching on stable`,
        );
        process.exit(1);
      }, bootTimeoutSeconds * 1000)
    : undefined;
try {
  await import(`${release.dir}/packages/foundry/src/start.ts`);
} catch (error) {
  clearTimeout(bootDeadline);
  if (release.trial) {
    await rejectCandidate(configDir, release.sha);
    log(`candidate ${short(release.sha)} failed to boot; relaunching on stable`);
  } else {
    const rejected = await restoreAfterFailedBoot(configDir);
    if (rejected)
      log(
        `boot failed on changed settings; set them aside at ${rejected} and restored the last settings that booted`,
      );
  }
  throw error;
}
clearTimeout(bootDeadline);
await recordBoot(configDir, release);
if (release.trial) log(`candidate ${short(release.sha)} booted; it is now stable`);
await recordBooted(configDir);
