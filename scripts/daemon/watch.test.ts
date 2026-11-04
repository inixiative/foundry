import { expect, test } from 'bun:test';
import type { DaemonRuntimeHook } from '../../packages/foundry/src/daemon/runtime-hook';
import { drain } from './watch';

// The auto-updater restarted the daemon mid-turn (2026-11-02) and lost the turn's outcome; it now
// waits for running turns before restarting, up to a timeout.

test('drain waits until no turn is live', async () => {
  const live = [2, 1, 0];
  const log: string[] = [];
  expect(
    await drain(
      () => live.shift() ?? 0,
      10_000,
      1,
      (m) => log.push(m),
    ),
  ).toBe(true);
  expect(log).toEqual([
    'waiting for 2 running turn(s) to finish before restarting',
    'waiting for 1 running turn(s) to finish before restarting',
  ]);
});

test('drain gives up at the timeout; a daemon not yet booted has nothing to drain', async () => {
  expect(
    await drain(
      () => 1,
      20,
      5,
      () => {},
    ),
  ).toBe(false);
  expect(
    await drain(
      () => undefined,
      20,
      5,
      () => {},
    ),
  ).toBe(true);
  expect(await drain(undefined, 20, 5, () => {})).toBe(true);
});

test('a daemon that can spin down is offered the update once; it calls back to restart', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { startUpdateWatcher } = await import('./watch');
  const configDir = mkdtempSync(join(tmpdir(), 'watch-offer-'));
  mkdirSync(join(configDir, 'releases'), { recursive: true });
  writeFileSync(
    join(configDir, 'releases', 'state.json'),
    JSON.stringify({ stable: 'a'.repeat(40), candidate: 'b'.repeat(40), failed: [] }),
  );
  const offers: Array<{ candidate: string; restart: () => void }> = [];
  const exits: number[] = [];
  const stop = startUpdateWatcher({
    // Not a git repo: staging fails and is logged; the staged candidate is still offered.
    repoRoot: configDir,
    configDir,
    intervalMs: 10,
    runtime: () => ({ liveTurns: () => 3, offerUpdate: (offer) => offers.push(offer) }),
    exit: (code) => exits.push(code),
  });
  for (let i = 0; i < 100 && offers.length === 0; i++) await Bun.sleep(10);
  await Bun.sleep(50);
  stop();
  expect(offers.map((offer) => offer.candidate)).toEqual(['b'.repeat(40)]);
  expect(exits).toEqual([]);
  offers[0]!.restart();
  for (let i = 0; i < 50 && exits.length === 0; i++) await Bun.sleep(5);
  expect(exits).toEqual([75]);
});

// 2026-11-04: a candidate took 19 minutes to boot at load 90–200; the watcher restarted mid-boot
// (no runtime hook yet read as "nothing to drain"), the relaunch read the cut-off boot as a failed
// one, and the candidate was marked failed for good.
test('a restart never interrupts a boot in progress, and the candidate being booted is not offered', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { startUpdateWatcher } = await import('./watch');
  const { readState } = await import('./update');
  const configDir = mkdtempSync(join(tmpdir(), 'watch-booting-'));
  mkdirSync(join(configDir, 'releases'), { recursive: true });
  const booting = 'b'.repeat(40);
  writeFileSync(
    join(configDir, 'releases', 'state.json'),
    JSON.stringify({ stable: 'a'.repeat(40), candidate: booting, booting, failed: [] }),
  );
  let hook: DaemonRuntimeHook | undefined;
  const offers: string[] = [];
  const exits: number[] = [];
  const log: string[] = [];
  const stop = startUpdateWatcher({
    repoRoot: configDir,
    configDir,
    intervalMs: 5,
    drainPollMs: 1,
    runtime: () => hook,
    exit: (code) => exits.push(code),
    log: (message) => log.push(message),
  });
  // Still booting: no runtime hook yet. Many ticks pass; nothing restarts.
  await Bun.sleep(100);
  expect(exits).toEqual([]);
  expect(log).toEqual(['the daemon is still booting; update checks wait until it is up']);

  // Booted (hook published) but the boot not yet recorded: the candidate is this process.
  hook = { liveTurns: () => 0, offerUpdate: (offer) => offers.push(offer.candidate) };
  await Bun.sleep(100);
  stop();
  expect(offers).toEqual([]);
  expect(exits).toEqual([]);
  expect((await readState(configDir)).failed).toEqual([]);
});

test('a booted daemon that cannot spin down is drained and restarted onto a staged candidate', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { startUpdateWatcher } = await import('./watch');
  const configDir = mkdtempSync(join(tmpdir(), 'watch-drain-'));
  mkdirSync(join(configDir, 'releases'), { recursive: true });
  writeFileSync(
    join(configDir, 'releases', 'state.json'),
    JSON.stringify({ stable: 'a'.repeat(40), candidate: 'c'.repeat(40), failed: [] }),
  );
  const exits: number[] = [];
  const stop = startUpdateWatcher({
    repoRoot: configDir,
    configDir,
    intervalMs: 5,
    drainPollMs: 1,
    runtime: () => ({ liveTurns: () => 0 }),
    exit: (code) => exits.push(code),
  });
  for (let i = 0; i < 100 && exits.length === 0; i++) await Bun.sleep(10);
  stop();
  expect(exits).toEqual([75]);
});
