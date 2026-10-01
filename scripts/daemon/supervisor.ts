#!/usr/bin/env bun
/**
 * Daemon entrypoint. Stages an update before launching — nothing is running
 * yet, so there is no in-flight job to interrupt — then boots a release (see
 * update.ts) and keeps watching, because a daemon left running for days would
 * otherwise never see main move. Local services come up first. A candidate
 * that fails to boot falls back to stable; a stable boot that fails on changed
 * settings restores the last settings that booted.
 */
import { dirname, resolve } from 'node:path';
import { recordBooted, restoreAfterFailedBoot } from './last-good';
import { ensureServices } from './services';
import { recordBoot, rejectCandidate, selectRelease, stageUpdate } from './update';
import { startUpdateWatcher } from './watch';

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

const settings = await readSettings();
const runtimes: { credentialFile: string }[] = Array.isArray(settings?.kingdomRuntimes)
  ? settings.kingdomRuntimes
  : [];
const checkSeconds = Number(settings?.daemon?.updateCheckSeconds ?? 300);
if (Number.isSafeInteger(checkSeconds) && checkSeconds >= 30)
  startUpdateWatcher({
    repoRoot,
    configDir,
    intervalMs: checkSeconds * 1000,
    runtimeDirectories: [
      ...new Set(runtimes.map((runtime) => dirname(resolve(runtime.credentialFile)))),
    ],
    log,
  });

const services = await ensureServices(repoRoot);
if (services.started.length) log(`services up: ${services.started.join(', ')}`);
if (services.detail) log(`services not started — ${services.detail}`);

const release = await selectRelease(repoRoot, configDir);
log(
  `starting ${release.trial ? 'candidate' : 'stable'} ${short(release.sha)} on port ${process.env.VIEWER_PORT ?? '4400'}`,
);
try {
  await import(`${release.dir}/packages/foundry/src/start.ts`);
} catch (error) {
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
await recordBoot(configDir, release);
if (release.trial) log(`candidate ${short(release.sha)} booted; it is now stable`);
await recordBooted(configDir);
