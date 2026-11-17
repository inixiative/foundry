/**
 * @atlas
 * @kind test
 * @partOf feature:daemon
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Hold, settingsHash } from '../../packages/foundry/src/daemon/boot-record';
import { waitWhileHeld } from './hold';
import type { UpdateResult } from './update';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const configDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-hold-'));
  dirs.push(dir);
  await writeFile(join(dir, 'settings.json'), '{"daemon":{}}');
  return dir;
};

const never = new Promise<void>(() => {});
const noUpdate = async (): Promise<UpdateResult> => ({ action: 'none' });
const failing = (dir: string): Hold => ({
  reason: 'boot-failures',
  since: 1,
  sha: 'a'.repeat(40),
  error: 'boom',
  failures: 2,
  settingsHash: settingsHash(dir),
});

test('a daemon the owner stopped waits for Start alone', async () => {
  const dir = await configDir();
  let press = () => {};
  const started = new Promise<void>((resolve) => {
    press = resolve;
  });
  let staged = 0;
  const waiting = waitWhileHeld({
    configDir: dir,
    hold: { reason: 'stopped', since: 1 },
    started,
    stageUpdate: async () => {
      staged++;
      return { action: 'staged', target: 'b' };
    },
    updateCheckMs: 5,
    settingsPollMs: 1,
  });
  await writeFile(join(dir, 'settings.json'), '{"daemon":{"autoUpdate":"apply"}}');
  await Bun.sleep(40);
  expect(await Promise.race([waiting, Bun.sleep(1).then(() => 'still held')])).toBe('still held');
  expect(staged).toBe(0);
  press();
  expect(await waiting).toBe('started');
});

test('failing boots are tried again on Start', async () => {
  const dir = await configDir();
  expect(
    await waitWhileHeld({
      configDir: dir,
      hold: failing(dir),
      started: Promise.resolve(),
      stageUpdate: noUpdate,
      updateCheckMs: 1000,
      settingsPollMs: 1000,
    }),
  ).toBe('started');
});

test('failing boots are tried again when the settings they read change, and not before', async () => {
  const dir = await configDir();
  const waiting = waitWhileHeld({
    configDir: dir,
    hold: failing(dir),
    started: never,
    stageUpdate: noUpdate,
    updateCheckMs: 1000,
    settingsPollMs: 1,
  });
  await Bun.sleep(1_200);
  expect(await Promise.race([waiting, Bun.sleep(1).then(() => 'still held')])).toBe('still held');
  await writeFile(join(dir, 'settings.json'), '{"daemon":{"autoUpdate":"apply"}}');
  expect(await waiting).toBe('settings-changed');
});

test('failing boots are tried again when a new release is staged', async () => {
  const dir = await configDir();
  const results: UpdateResult[] = [
    { action: 'none' },
    { action: 'skipped', target: 'a', detail: 'it failed to boot before' },
    { action: 'staged', target: 'b' },
  ];
  expect(
    await waitWhileHeld({
      configDir: dir,
      hold: failing(dir),
      started: never,
      stageUpdate: async () => results.shift() ?? { action: 'none' },
      updateCheckMs: 2,
      settingsPollMs: 1000,
    }),
  ).toBe('update-staged');
  expect(results).toEqual([]);
});

test('a failing-boot hold tries again by itself after its backoff', async () => {
  const dir = await configDir();
  expect(
    await waitWhileHeld({
      configDir: dir,
      hold: failing(dir),
      started: never,
      updateCheckMs: 1000,
      settingsPollMs: 1000,
      retryAfterMs: 1,
    }),
  ).toBe('retry-due');
});

test('with update checks off nothing is staged, and the wait never spins', async () => {
  const dir = await configDir();
  let press = () => {};
  const started = new Promise<void>((resolve) => {
    press = resolve;
  });
  const cpu = process.cpuUsage();
  const waiting = waitWhileHeld({
    configDir: dir,
    hold: failing(dir),
    started,
    updateCheckMs: 0,
    settingsPollMs: 0,
    retryAfterMs: 60_000,
  });
  await Bun.sleep(1_500);
  press();
  expect(await waiting).toBe('started');
  // Sleeps never drop below a second, so 1.5 s held costs next to no CPU (a spin used a whole core).
  expect(process.cpuUsage(cpu).user).toBeLessThan(300_000);
});

test('a release build in flight finishes before the wait returns', async () => {
  const dir = await configDir();
  let finished = false;
  let press = () => {};
  const started = new Promise<void>((resolve) => {
    press = resolve;
  });
  const waiting = waitWhileHeld({
    configDir: dir,
    hold: failing(dir),
    started,
    stageUpdate: async () => {
      press();
      await Bun.sleep(200);
      finished = true;
      return { action: 'none' };
    },
    updateCheckMs: 60_000,
    settingsPollMs: 60_000,
    retryAfterMs: 60_000,
  });
  expect(await waiting).toBe('started');
  expect(finished).toBe(true);
});
