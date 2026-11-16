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
 * packages/foundry/src/daemon/restart-roll.ts). Local services come up first. With
 * daemon.updateAgentClis on, the agent CLIs are upgraded before the release boots, while no session
 * runs (packages/foundry/src/daemon/agent-cli-update.ts). A candidate
 * that fails to boot (it throws, or is still booting at the boot deadline) falls back to
 * stable; a stable boot still booting at the deadline relaunches; a stable boot that fails on
 * changed settings restores the last settings that booted.
 */
import type { updateAgentClis } from '../../packages/foundry/src/daemon/agent-cli-update';
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

// A daemon module from the booted release when it has one (it speaks to the daemon it ships with);
// this checkout's otherwise, so a release that lacks it or whose copy won't load still boots.
const fromRelease = async <T>(
  path: string,
  name: string,
  checkout: () => Promise<T>,
): Promise<T> => {
  const file = `${release.dir}/${path}`;
  if (await Bun.file(file).exists())
    try {
      const loaded = ((await import(file)) as Record<string, T | undefined>)[name];
      if (loaded) return loaded;
    } catch (error) {
      log(`release ${path} did not load, using the checkout's — ${String(error)}`);
    }
  return checkout();
};
const startUpdateWatcher = await fromRelease(
  'scripts/daemon/watch.ts',
  'startUpdateWatcher',
  async () => checkoutWatcher,
);
const settings = await readSettings();
// Before the release boots, so no session runs on a CLI this moves (daemon.updateAgentClis). A
// module that won't load, or a check that throws, is logged and the release boots anyway.
const agentCliUpdate = 'packages/foundry/src/daemon/agent-cli-update.ts';
try {
  const update = await fromRelease<typeof updateAgentClis>(
    agentCliUpdate,
    'updateAgentClis',
    async () => (await import(`${repoRoot}/${agentCliUpdate}`)).updateAgentClis,
  );
  await update({
    updates: settings?.daemon?.updateAgentClis === true,
    configDir,
    fixturesDir: `${release.dir}/packages/foundry/tests/fixtures/vcr`,
    log: (message: string) => log(`agent CLIs: ${message}`),
  });
} catch (error) {
  log(`agent CLI check failed — ${String(error)}`);
}
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
// A boot still running at the deadline is a failed boot: a candidate is marked failed and the
// relaunch runs stable; a stable boot just relaunches (and picks up a newer candidate if one is staged).
let bootSettled = false;
const bootDeadline =
  Number.isSafeInteger(bootTimeoutSeconds) && bootTimeoutSeconds > 0
    ? setTimeout(async () => {
        if (bootSettled) return;
        bootSettled = true;
        if (release.trial) await rejectCandidate(configDir, release.sha);
        log(
          `${release.trial ? 'candidate' : 'stable'} ${short(release.sha)} was still booting after ${bootTimeoutSeconds}s; ${release.trial ? 'marked failed, relaunching on stable' : 'relaunching'}`,
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
// The deadline already ruled (it is rejecting and exiting): don't also record this boot.
if (bootSettled) await new Promise(() => {});
bootSettled = true;
await recordBoot(configDir, release);
if (release.trial) log(`candidate ${short(release.sha)} booted; it is now stable`);
await recordBooted(configDir);
