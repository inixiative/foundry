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
 * stable; a stable boot still booting at the deadline relaunches; a stable boot that fails on
 * changed settings restores the last settings that booted.
 *
 * The viewer's port is never dark: this process serves the status page on it from its first moment
 * and hands the port to the viewer as it binds (`packages/foundry/src/daemon/port-handoff.ts`). A
 * stable release that fails to boot twice the same way (it throws, exits, or dies in its first minute)
 * is held instead of relaunched for ever: the page shows the error and Try again, and the boot is
 * tried again on Try again, changed settings, a new release, or by itself after a backoff
 * (`hold.ts`). `daemon:stop` is the same hold, asked for.
 */
import { randomUUID } from 'node:crypto';
import {
  BOOTED_AFTER_MS,
  bootErrorLine,
  clearHold,
  holdAfterBoots,
  readBoots,
  readHold,
  recordBootOutcome,
  settingsHash,
  writeHold,
} from '../../packages/foundry/src/daemon/boot-record';
import { DAEMON_LOG_DIR } from '../../packages/foundry/src/daemon/plist';
import { publishPortHolder } from '../../packages/foundry/src/daemon/port-handoff';
import type { DaemonLiveStatus, DaemonPhase } from '../../packages/foundry/src/daemon/status';
import {
  type StatusServer,
  startStatusServer,
} from '../../packages/foundry/src/daemon/status-server';
import { waitWhileHeld } from './hold';
import { recordBooted, restoreAfterFailedBoot } from './last-good';
import { ensureServices } from './services';
import {
  MAX_INTERRUPTED_BOOTS,
  RESTART_EXIT_CODE,
  type Release,
  recordBoot,
  rejectCandidate,
  selectRelease,
  stageUpdate,
} from './update';
import { startUpdateWatcher as checkoutWatcher } from './watch';

const repoRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const configDir = `${repoRoot}/.foundry`;
const port = Number.parseInt(process.env.VIEWER_PORT ?? '4500', 10);

const log = (message: string) => console.log(`[${new Date().toISOString()}] daemon: ${message}`);

const readSettings = async () => {
  try {
    return await Bun.file(`${repoRoot}/.foundry/settings.json`).json();
  } catch {
    return undefined;
  }
};

const short = (sha?: string) => sha?.slice(0, 8);

// -- The status page, on the viewer's port until the viewer binds it --
const logDir = process.env.FOUNDRY_DAEMON === '1' ? DAEMON_LOG_DIR : undefined;
let live: DaemonLiveStatus = {
  servedBy: 'supervisor',
  bootId: randomUUID(),
  phase: 'checking-for-update',
  phaseSince: Date.now(),
  ...(logDir ? { logDir } : {}),
};
const enter = (phase: DaemonPhase, release?: Release) => {
  live = {
    ...live,
    phase,
    phaseSince: Date.now(),
    ...(release ? { release: { sha: release.sha, trial: release.trial } } : {}),
  };
};
let pressStart: () => void = () => {};
const started = new Promise<void>((resolve) => {
  pressStart = resolve;
});
const serveStatusPage = (): StatusServer | undefined => {
  try {
    return startStatusServer({ port, configDir, live: () => live, requestStart: pressStart });
  } catch (error) {
    log(`status page not served on port ${port} — ${String(error)}`);
    return undefined;
  }
};
let statusServer = serveStatusPage();

const settings = await readSettings();
const checkSeconds = Number(settings?.daemon?.updateCheckSeconds ?? 300);
const spinDownSeconds = Number(settings?.daemon?.drainTimeoutSeconds);
// Generous: a boot took 19 minutes at load 90–200 (2026-11-04).
const bootTimeoutSeconds = Number(settings?.daemon?.bootTimeoutSeconds ?? 3600);
const updateChecks = Number.isSafeInteger(checkSeconds) && checkSeconds >= 30;

// -- A hold: boot nothing until there is a reason to --
const hold = readHold(configDir);
if (hold) {
  enter('held');
  // Held with the port taken (another Foundry, a dev server): keep holding and keep trying for the
  // port, so the page shows up once it is free. Booting instead is what the hold exists to stop.
  while (!statusServer) {
    await Bun.sleep(10_000);
    statusServer = serveStatusPage();
  }
  log(
    hold.reason === 'stopped'
      ? `stopped by the owner; the status page on port ${port} starts it`
      : `held: ${short(hold.sha)} failed to boot ${hold.failures} times with the same error (${hold.error}); waiting for Start, changed settings, a new release or the retry`,
  );
  const released = await waitWhileHeld({
    configDir,
    hold,
    started,
    ...(updateChecks ? { stageUpdate: () => stageUpdate(repoRoot, configDir) } : {}),
    updateCheckMs: checkSeconds * 1000,
  });
  clearHold(configDir);
  log(`hold released (${released}); booting`);
}

enter('checking-for-update');
const update = await stageUpdate(repoRoot, configDir);
if (update.action === 'staged') log(`staged origin/main ${short(update.target)} as the candidate`);
if (update.action === 'reported')
  log(`origin/main is at ${short(update.target)} (autoUpdate is not "apply")`);
if (update.action === 'skipped') log(`not staging ${short(update.target)}: ${update.detail}`);
if (update.action === 'failed') log(`update skipped — ${update.detail}`);

enter('starting-services');
const services = await ensureServices(repoRoot);
if (services.started.length) log(`services up: ${services.started.join(', ')}`);
if (services.detail) log(`services not started — ${services.detail}`);

const release = await selectRelease(repoRoot, configDir);
if (release.interruptedBoots)
  log(
    `candidate ${short(release.sha)}'s last boot was cut off before it finished; trying again (${release.interruptedBoots + 1} of ${MAX_INTERRUPTED_BOOTS})`,
  );
enter('booting', release);

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
if (updateChecks)
  startUpdateWatcher({
    repoRoot,
    configDir,
    intervalMs: checkSeconds * 1000,
    ...(Number.isSafeInteger(spinDownSeconds) && spinDownSeconds >= 0
      ? { drainTimeoutMs: spinDownSeconds * 1000 }
      : {}),
    log,
  });
log(`starting ${release.trial ? 'candidate' : 'stable'} ${short(release.sha)} on port ${port}`);

// The viewer frees the port as it binds (`releaseHeldPort` in its server); a release from before the
// handoff never would, so the port is freed for it now.
if (statusServer) {
  const stopStatusServer = statusServer.stop;
  const viewerServer = Bun.file(`${release.dir}/packages/foundry/src/viewer/server.ts`);
  if ((await viewerServer.exists()) && (await viewerServer.text()).includes('releaseHeldPort('))
    publishPortHolder(stopStatusServer);
  else await stopStatusServer();
}
process.env.FOUNDRY_RELEASE = release.sha;
process.env.FOUNDRY_RELEASE_TRIAL = release.trial ? '1' : '0';
if (logDir) process.env.FOUNDRY_LOG_DIR = logDir;

const bootStartedAt = Date.now();
/** Set once this boot's outcome is in `boots.jsonl`. */
let recorded = false;
/** The last error line the boot printed: what an exit without a throw is recorded with. */
let lastErrorLine: string | undefined;
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (!recorded) {
    const line = args
      .map(String)
      .join(' ')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
    if (line) lastErrorLine = line;
  }
  consoleError(...args);
};
/** Records how the boot ended and, for a stable release failing the same way again, the hold. */
const recordFailedBoot = (outcome: 'failed' | 'timed-out', error?: string) => {
  if (recorded) return;
  recorded = true;
  recordBootOutcome(configDir, {
    sha: release.sha,
    trial: release.trial,
    startedAt: bootStartedAt,
    endedAt: Date.now(),
    outcome,
    ...(error !== undefined ? { error } : {}),
  });
  const next = holdAfterBoots(readBoots(configDir), settingsHash(configDir));
  if (!next) return;
  writeHold(configDir, next);
  log(`${short(release.sha)} failed to boot again the same way; the next launch holds`);
};
// A boot that exits without throwing (start.ts exits on a missing provider key) or dies in its first
// minute up is a failed boot too. Exit 0 is a shutdown (launchd stopping it) and 75 a planned
// restart: neither is a failure. Synchronous: only synchronous work runs on `exit`.
process.on('exit', (code) => {
  if (code === 0 || code === RESTART_EXIT_CODE) return;
  const ranFor = Math.round((Date.now() - bootStartedAt) / 1000);
  recordFailedBoot(
    'failed',
    lastErrorLine ?? `exited with code ${code} ${ranFor}s after the boot started; see the logs`,
  );
});

// A boot still running at the deadline is a failed boot: a candidate is marked failed and the
// relaunch runs stable; a stable boot just relaunches (and picks up a newer candidate if one is staged).
let bootSettled = false;
const bootDeadline =
  Number.isSafeInteger(bootTimeoutSeconds) && bootTimeoutSeconds > 0
    ? setTimeout(async () => {
        if (bootSettled) return;
        bootSettled = true;
        if (release.trial) await rejectCandidate(configDir, release.sha);
        recordFailedBoot('timed-out');
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
  // After the restore, so the hold remembers the settings the next boot will read.
  if (!bootSettled) recordFailedBoot('failed', bootErrorLine(error));
  throw error;
}
clearTimeout(bootDeadline);
// The deadline already ruled (it is rejecting and exiting): don't also record this boot.
if (bootSettled) await new Promise(() => {});
bootSettled = true;
await recordBoot(configDir, release);
if (release.trial) log(`candidate ${short(release.sha)} booted; it is now stable`);
await recordBooted(configDir);
// Booted once it has stayed up a minute: dying sooner is recorded as a failed boot (above).
setTimeout(() => {
  if (recorded) return;
  recorded = true;
  recordBootOutcome(configDir, {
    sha: release.sha,
    trial: release.trial,
    startedAt: bootStartedAt,
    endedAt: Date.now(),
    outcome: 'booted',
  });
}, BOOTED_AFTER_MS).unref();
