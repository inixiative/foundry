/**
 * @atlas
 * @kind test
 * @partOf feature:daemon
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOOT_FAILURES_BEFORE_HOLD,
  type BootRecord,
  bootErrorLine,
  clearHold,
  holdAfterBoots,
  readBoots,
  readHold,
  recordBootOutcome,
  retryDelayMs,
  writeHold,
} from '../src/daemon/boot-record';
import { publishPortHolder, releaseHeldPort } from '../src/daemon/port-handoff';
import type { DaemonLiveStatus, DaemonStatus } from '../src/daemon/status';
import { type StatusServer, startStatusServer } from '../src/daemon/status-server';

const dirs: string[] = [];
const servers: StatusServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const configDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-daemon-status-'));
  dirs.push(dir);
  return dir;
};

const STABLE = 'a'.repeat(40);
const CANDIDATE = 'b'.repeat(40);
const boot = (overrides: Partial<BootRecord> = {}): BootRecord => ({
  sha: STABLE,
  trial: false,
  startedAt: 1000,
  endedAt: 3000,
  outcome: 'failed',
  error: 'boom',
  ...overrides,
});

test('boots are kept in order, and a line that does not parse is skipped', async () => {
  const dir = configDir();
  expect(readBoots(dir)).toEqual([]);
  recordBootOutcome(dir, boot({ outcome: 'booted', error: undefined }));
  writeFileSync(join(dir, 'releases', 'boots.jsonl'), 'not json\n', { flag: 'a' });
  recordBootOutcome(dir, boot());
  expect(readBoots(dir).map((b) => b.outcome)).toEqual(['booted', 'failed']);
  expect(bootErrorLine(new Error('first line\nsecond line'))).toBe('first line');
});

test('the same stable failure twice in a row holds; anything else relaunches', () => {
  expect(BOOT_FAILURES_BEFORE_HOLD).toBe(2);
  expect(holdAfterBoots([], 'h')).toBeUndefined();
  expect(holdAfterBoots([boot()], 'h')).toBeUndefined();
  expect(holdAfterBoots([boot(), boot()], 'h', 9)).toEqual({
    reason: 'boot-failures',
    since: 9,
    sha: STABLE,
    error: 'boom',
    failures: 2,
    settingsHash: 'h',
  });
  // 2026-11-16: each new commit on main failed between stable's failures; candidates are not counted.
  const outage = [
    boot({ sha: CANDIDATE, trial: true }),
    boot(),
    boot({ sha: 'c'.repeat(40), trial: true }),
    boot(),
    boot({ sha: 'd'.repeat(40), trial: true }),
  ];
  expect(holdAfterBoots(outage, 'h')).toMatchObject({ sha: STABLE, failures: 2 });
  // A different error, a different release or a boot in between starts the count again.
  expect(holdAfterBoots([boot({ error: 'other' }), boot()], 'h')).toBeUndefined();
  expect(holdAfterBoots([boot({ sha: CANDIDATE }), boot()], 'h')).toBeUndefined();
  expect(
    holdAfterBoots([boot(), boot({ outcome: 'booted', error: undefined }), boot()], 'h'),
  ).toBeUndefined();
  // Only candidates failing never holds: their relaunch runs stable.
  expect(
    holdAfterBoots(
      [boot({ sha: CANDIDATE, trial: true }), boot({ sha: CANDIDATE, trial: true })],
      'h',
    ),
  ).toBeUndefined();
  // A boot that ran past its deadline relaunches: under load a boot can take long and still succeed.
  const slow = boot({ outcome: 'timed-out', error: undefined });
  expect(holdAfterBoots([slow, slow], 'h')).toBeUndefined();
});

test('an error is kept by its first non-empty line, and a hold retries by itself with a backoff', () => {
  expect(bootErrorLine(new Error('\n\n  first line\nsecond'))).toBe('first line');
  expect(bootErrorLine('')).toBe('the boot failed with no message');
  expect(retryDelayMs(2)).toBe(60_000);
  expect(retryDelayMs(3)).toBe(5 * 60_000);
  expect(retryDelayMs(4)).toBe(15 * 60_000);
  expect(retryDelayMs(50)).toBe(60 * 60_000);
});

test('a hold is written, read and cleared; a malformed one is no hold', async () => {
  const dir = configDir();
  expect(readHold(dir)).toBeUndefined();
  writeHold(dir, { reason: 'stopped', since: 5 });
  expect(readHold(dir)).toEqual({ reason: 'stopped', since: 5 });
  clearHold(dir);
  expect(readHold(dir)).toBeUndefined();
  writeFileSync(join(dir, 'releases', 'hold.json'), '{"reason":"napping"}');
  expect(readHold(dir)).toBeUndefined();
});

function serve(dir: string, live: Partial<DaemonLiveStatus> = {}) {
  const starts: number[] = [];
  let status: DaemonLiveStatus = {
    servedBy: 'supervisor',
    bootId: 'supervisor-boot',
    phase: 'booting',
    phaseSince: 1,
    ...live,
  };
  const server = startStatusServer({
    port: 0,
    configDir: dir,
    live: () => status,
    requestStart: () => starts.push(Date.now()),
  });
  servers.push(server);
  return {
    server,
    starts,
    url: `http://127.0.0.1:${server.port}`,
    set: (next: Partial<DaemonLiveStatus>) => {
      status = { ...status, ...next };
    },
  };
}

test('the status server answers every page address with the status page and says what Foundry is doing', async () => {
  const dir = configDir();
  mkdirSync(join(dir, 'releases'), { recursive: true });
  writeFileSync(
    join(dir, 'releases', 'state.json'),
    JSON.stringify({ stable: STABLE, candidate: CANDIDATE, failed: ['c'.repeat(40)] }),
  );
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ daemon: { autoUpdate: 'apply' } }));
  recordBootOutcome(dir, boot({ startedAt: 1 }));
  recordBootOutcome(dir, boot({ startedAt: 2 }));
  const { url } = serve(dir, { release: { sha: CANDIDATE, trial: true } });

  for (const path of ['/', '/settings', '/projects/p/analytics', '/status']) {
    const page = await fetch(`${url}${path}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<title>Foundry status</title>');
  }
  const status = (await (await fetch(`${url}/api/daemon/status`)).json()) as DaemonStatus;
  expect(status).toMatchObject({
    servedBy: 'supervisor',
    bootId: 'supervisor-boot',
    phase: 'booting',
    release: { sha: CANDIDATE, trial: true },
    stable: STABLE,
    candidate: CANDIDATE,
    failed: ['c'.repeat(40)],
    autoUpdate: 'apply',
  });
  // Newest first.
  expect(status.boots.map((b) => b.startedAt)).toEqual([2, 1]);
  expect((await fetch(`${url}/ui/favicon.svg`)).status).toBe(200);
  expect((await fetch(`${url}/ui/theme/public.css`)).status).toBe(200);
  expect((await fetch(`${url}/ui/theme/..%2F..%2Fpackage.json`)).status).toBe(404);
  expect((await fetch(`${url}/ui/app.js`)).status).toBe(404);
});

test('an open viewer is told the daemon changed, and every other call that Foundry is not running', async () => {
  const { url } = serve(configDir());
  // The viewer reloads when `/api/daemon/update` names a boot id that is not its daemon's.
  expect(await (await fetch(`${url}/api/daemon/update`)).json()).toEqual({
    bootId: 'supervisor-boot',
    phase: 'restarting',
  });
  const api = await fetch(`${url}/api/threads`);
  expect(api.status).toBe(503);
  expect(await api.json()).toEqual({ error: 'Foundry is not running', statusUrl: '/status' });
  expect((await fetch(`${url}/`, { method: 'POST' })).status).toBe(503);
});

test('Start is taken only from this machine, only by POST, and only while held', async () => {
  const dir = configDir();
  const { url, starts, set } = serve(dir);
  expect((await fetch(`${url}/api/daemon/start`, { method: 'POST' })).status).toBe(409);
  set({ phase: 'held' });
  expect((await fetch(`${url}/api/daemon/start`)).status).toBe(405);
  expect(
    (
      await fetch(`${url}/api/daemon/start`, {
        method: 'POST',
        headers: { origin: 'https://example.com' },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${url}/api/daemon/start`, { method: 'POST', headers: { host: 'example.com' } }))
      .status,
  ).toBe(403);
  // A proxy (a tunnel someone runs) rewriting the host to localhost is not this machine.
  expect(
    (
      await fetch(`${url}/api/daemon/start`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${url}/api/daemon/status`, { headers: { forwarded: 'for=203.0.113.9' } })).status,
  ).toBe(403);
  expect(starts).toEqual([]);
  const started = await fetch(`${url}/api/daemon/start`, {
    method: 'POST',
    headers: { origin: url },
  });
  expect(started.status).toBe(200);
  expect(starts).toHaveLength(1);
});

test('the viewer takes the port from the status server as it binds', async () => {
  const { server, url } = serve(configDir());
  publishPortHolder(server.stop);
  // What `startViewer` does just before `Bun.serve`.
  await releaseHeldPort();
  const viewer = Bun.serve({
    port: server.port,
    hostname: '127.0.0.1',
    fetch: () => new Response('viewer'),
  });
  try {
    expect(await (await fetch(url)).text()).toBe('viewer');
  } finally {
    await viewer.stop(true);
  }
  // Nothing holds the port now: releasing again is nothing.
  await releaseHeldPort();
});
