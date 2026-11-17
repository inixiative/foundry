/**
 * @atlas
 * @kind service
 * @partOf feature:daemon
 */
/**
 * What the supervisor remembers between launches, beside the release state: every boot and how it
 * ended (`boots.jsonl`), and whether the daemon is held instead of booted (`hold.json`).
 *
 * A boot that fails exits the process, and launchd relaunches it. When stable fails the same way
 * again there is nothing an immediate retry would change, so the supervisor holds: it keeps the
 * status page up with the error and waits for a reason to try again (the owner's Start, changed
 * settings, a new release, or a retry with backoff, so a transient failure still recovers). On
 * 2026-11-16 a repository file no release could boot on relaunched the daemon about 1,600 times
 * over five hours with nothing on the port.
 *
 * Synchronous on purpose: a boot that calls `process.exit` is recorded from the process's `exit`
 * event, where only synchronous work runs.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { releasesRoot } from './release-state';

/** `failed`: it threw, exited, or died within its first minute up. `timed-out`: still booting at the deadline. */
export type BootOutcome = 'booted' | 'failed' | 'timed-out';

export interface BootRecord {
  readonly sha: string;
  readonly trial: boolean;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: BootOutcome;
  /** The first non-empty line of what the boot threw, or the last error line it printed before it exited. */
  readonly error?: string;
}

/** Why the daemon is held: the owner stopped it, or its stable boots keep failing the same way. */
export type Hold =
  | { readonly reason: 'stopped'; readonly since: number }
  | {
      readonly reason: 'boot-failures';
      readonly since: number;
      readonly sha: string;
      readonly error: string;
      readonly failures: number;
      /** The settings the failing boots read, so a changed file is a reason to try again. */
      readonly settingsHash: string;
    };

/** Failed stable boots of one release with one error, in a row, before the supervisor holds. */
export const BOOT_FAILURES_BEFORE_HOLD = 2;
/** A boot is `booted` once it has stayed up this long; dying sooner is a failed boot. */
export const BOOTED_AFTER_MS = 60_000;
/** A held daemon tries again by itself after these delays (by failures beyond the hold), then hourly. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const KEEP_BOOTS = 200;

const bootsPath = (configDir: string) => join(releasesRoot(configDir), 'boots.jsonl');
const holdPath = (configDir: string) => join(releasesRoot(configDir), 'hold.json');

/** The first non-empty line of an error, bounded: what the status page shows and the hold compares. */
export const bootErrorLine = (error: unknown): string =>
  (
    String(error instanceof Error ? error.message : error)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? 'the boot failed with no message'
  ).slice(0, 2000);

export const settingsHash = (configDir: string): string => {
  const path = join(configDir, 'settings.json');
  return existsSync(path) ? Bun.hash(readFileSync(path, 'utf8')).toString(16) : 'none';
};

/** Every recorded boot, oldest first. A line that does not parse is skipped. */
export const readBoots = (configDir: string): BootRecord[] => {
  const path = bootsPath(configDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as BootRecord];
      } catch {
        return [];
      }
    });
};

export const recordBootOutcome = (configDir: string, boot: BootRecord): void => {
  mkdirSync(releasesRoot(configDir), { recursive: true });
  const boots = readBoots(configDir);
  if (boots.length < KEEP_BOOTS) {
    appendFileSync(bootsPath(configDir), `${JSON.stringify(boot)}\n`);
    return;
  }
  const kept = [...boots.slice(-(KEEP_BOOTS - 1)), boot];
  writeFileSync(bootsPath(configDir), `${kept.map((b) => JSON.stringify(b)).join('\n')}\n`);
};

export const readHold = (configDir: string): Hold | undefined => {
  try {
    const hold = JSON.parse(readFileSync(holdPath(configDir), 'utf8')) as Hold;
    return hold?.reason === 'stopped' || hold?.reason === 'boot-failures' ? hold : undefined;
  } catch {
    return undefined;
  }
};

export const writeHold = (configDir: string, hold: Hold): void => {
  mkdirSync(releasesRoot(configDir), { recursive: true });
  writeFileSync(holdPath(configDir), JSON.stringify(hold, null, 2));
};

export const clearHold = (configDir: string): void => {
  rmSync(holdPath(configDir), { force: true });
};

/**
 * The hold the boots so far call for: the latest stable boots are `BOOT_FAILURES_BEFORE_HOLD`
 * failures in a row of one release with one error. A candidate's boots are skipped, not counted
 * (its failure relaunches on stable, and on 11-16 each new commit on main failed between stable's
 * failures); a timed-out boot is not a failure here (under load a boot can take long and still
 * succeed: it relaunches, as before).
 */
export const holdAfterBoots = (
  boots: readonly BootRecord[],
  hashOfSettings: string,
  now = Date.now(),
): Extract<Hold, { reason: 'boot-failures' }> | undefined => {
  const stable = boots.filter((boot) => !boot.trial);
  const last = stable.at(-1);
  if (!last || last.outcome !== 'failed') return undefined;
  let failures = 0;
  for (let i = stable.length - 1; i >= 0; i--) {
    const boot = stable[i]!;
    if (boot.outcome !== 'failed' || boot.sha !== last.sha || boot.error !== last.error) break;
    failures++;
  }
  if (failures < BOOT_FAILURES_BEFORE_HOLD) return undefined;
  return {
    reason: 'boot-failures',
    since: now,
    sha: last.sha,
    error: last.error ?? 'the boot failed with no message',
    failures,
    settingsHash: hashOfSettings,
  };
};

/** When a hold on failing boots tries again by itself: sooner after the first hold, then hourly. */
export const retryDelayMs = (failures: number): number =>
  RETRY_DELAYS_MS[
    Math.min(Math.max(failures - BOOT_FAILURES_BEFORE_HOLD, 0), RETRY_DELAYS_MS.length - 1)
  ]!;
