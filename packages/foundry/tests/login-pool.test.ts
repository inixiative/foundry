import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LimitSnapshot } from '@inixiative/agent-session';
import type { NativeProfileSource } from '../src/providers/default-profiles';
import { LoginPoolAuthentication, LoginRunLog } from '../src/providers/login-pool';
import { SubscriptionAuthentication } from '../src/providers/subscription-authentication';
import type { LoginPoolSettings } from '../src/providers/subscription-policy';
import { subscriptionStatusProcess } from './helpers/subscription-transport';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const reading = (used: number, blocked = false): LimitSnapshot => ({
  runtime: 'claude',
  source: 'poll',
  observedAt: NOW,
  windows: [{ id: 'five_hour', usedPercent: used, windowMinutes: 300, resetsAt: NOW + 3_600_000 }],
  ...(blocked ? { blocked: true } : {}),
});

/** Three Claude logins (inixiative, personal, work) with stubbed readings and sign-in checks. */
function fixture(
  options: { used?: Record<string, number>; signedOut?: string[]; unread?: string[] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'login-pool-'));
  roots.push(root);
  const login = (name: string): NativeProfileSource => {
    const profileDirectory = join(root, name);
    mkdirSync(profileDirectory, { mode: 0o700 });
    return {
      id: crypto.randomUUID(),
      integrationId: crypto.randomUUID(),
      runtime: 'claude',
      mode: 'native-profile',
      profileDirectory,
      name,
    };
  };
  const logins = [login('inixiative'), login('personal'), login('work')];
  const byName = Object.fromEntries(logins.map((l) => [l.name!, l]));
  const used = { inixiative: 10, personal: 10, work: 10, ...options.used };
  const probes: string[] = [];
  let settings: LoginPoolSettings = {};
  const runs = new LoginRunLog(join(root, 'runs.json'), () => NOW);
  const pool = new LoginPoolAuthentication({
    runtime: 'claude',
    directory: join(root, 'runtime-profiles'),
    logins: () => logins,
    primary: () => logins[0]!,
    settings: () => settings,
    runs,
    now: () => NOW,
    own: () => false,
    probe: async (l) => {
      probes.push(l.name!);
      if (options.unread?.includes(l.name!)) return undefined;
      const percent = used[l.name as keyof typeof used];
      return reading(percent, percent >= 100);
    },
    authentication: (l) =>
      new SubscriptionAuthentication(join(root, 'runtime-profiles'), l, () =>
        subscriptionStatusProcess(!options.signedOut?.includes(l.name!)),
      ),
  });
  return {
    root,
    logins,
    byName,
    used,
    probes,
    runs,
    pool,
    set: (next: LoginPoolSettings) => {
      settings = next;
    },
  };
}

/** One admitted turn of a thread: the login it ran on. */
async function turn(f: ReturnType<typeof fixture>, threadId: string): Promise<string> {
  const launch = await f.pool.prepare(threadId, 'claude');
  launch.admitted?.();
  launch.release();
  return f.logins.find((l) => l.id === launch.sourceId)!.name!;
}

test('quartile-balanced sends a new thread to the least-used login and keeps a thread on its own', async () => {
  const f = fixture({ used: { inixiative: 60, personal: 20, work: 40 } });
  expect(await turn(f, 'a')).toBe('personal');
  // A thread stays on its login while it can serve: its native session lives in that home.
  f.used.personal = 70;
  await f.pool.refresh();
  expect(await turn(f, 'a')).toBe('personal');
  // Readings are cached a few minutes; a new thread ranks on the reading it has.
  expect(await turn(f, 'b')).toBe('personal');
  expect(f.runs.ofThread('a').map((r) => r.why)).toEqual(['balanced', 'kept']);
  expect(f.runs.counts('claude')).toEqual({ [f.byName.personal!.id]: 3 });
});

test('an exhausted login is skipped, and a thread on it moves to another', async () => {
  const f = fixture({ used: { inixiative: 100, personal: 30, work: 50 } });
  // Seed thread a on inixiative from an earlier run (the record a restarted daemon reads).
  f.runs.record({
    runtime: 'claude',
    loginId: f.byName.inixiative!.id,
    threadId: 'a',
    why: 'balanced',
  });
  expect(await turn(f, 'a')).toBe('personal');
  expect(f.runs.ofThread('a').at(-1)!.why).toBe('moved');
  const state = f.pool.state({ from: 'default' });
  expect(state.logins.find((l) => l.name === 'inixiative')!.status).toBe('exhausted');
  expect(state.balancing).toEqual({
    state: 'balanced',
    across: 2,
    routing: 'quartile-balanced',
    by: 'usage',
  });
});

test('pinned is balancing off: every launch goes to the pinned login, and the scale says so', async () => {
  const f = fixture({ used: { inixiative: 80, personal: 5, work: 5 } });
  f.set({ pinned: true, preferredLoginId: f.byName.inixiative!.id });
  expect(await turn(f, 'a')).toBe('inixiative');
  expect(await turn(f, 'b')).toBe('inixiative');
  expect(f.runs.ofThread('b')[0]!.why).toBe('pinned');
  const state = f.pool.state({
    pinned: true,
    preferredLoginId: f.byName.inixiative!.id,
    from: 'foundry',
  });
  expect(state.balancing).toEqual({ state: 'stopped', reason: 'pinned', on: 'inixiative' });
  // Pinned to an exhausted login, nothing serves: no fallback to another subscription.
  f.used.inixiative = 100;
  const exhausted = fixture({ used: { inixiative: 100 } });
  exhausted.set({ pinned: true, preferredLoginId: exhausted.byName.inixiative!.id });
  await expect(turn(exhausted, 'c')).rejects.toThrow('Every claude login is unavailable');
});

test('owner-first prefers its login until it is exhausted', async () => {
  const f = fixture({ used: { inixiative: 10, personal: 70, work: 40 } });
  f.set({ routing: 'owner-first', preferredLoginId: f.byName.personal!.id });
  expect(await turn(f, 'a')).toBe('personal');
  expect(f.runs.ofThread('a')[0]!.why).toBe('preferred');
});

test('the scale reports why balancing stopped: one login left, none left', async () => {
  const f = fixture({ used: { inixiative: 100, personal: 100, work: 20 } });
  await f.pool.refresh();
  expect(f.pool.state({ from: 'default' }).balancing).toEqual({
    state: 'stopped',
    reason: 'one-left',
    on: 'work',
  });
  const none = fixture({ used: { inixiative: 100, personal: 100, work: 100 } });
  await none.pool.refresh();
  expect(none.pool.state({ from: 'default' }).balancing).toEqual({
    state: 'stopped',
    reason: 'none-left',
  });
});

test('a login that fails its sign-in check is set aside as expired and the next one serves', async () => {
  const f = fixture({ used: { inixiative: 5, personal: 50, work: 60 }, signedOut: ['inixiative'] });
  expect(await turn(f, 'a')).toBe('personal');
  await f.pool.checkLogins();
  const state = f.pool.state({ from: 'default' });
  expect(state.logins.find((l) => l.name === 'inixiative')!.status).toBe('expired');
  expect(state.balancing).toEqual({
    state: 'balanced',
    across: 2,
    routing: 'quartile-balanced',
    by: 'usage',
  });
});

test('the run record survives a restart: a thread resumes on its own login', async () => {
  const f = fixture({ used: { inixiative: 50, personal: 10, work: 90 } });
  expect(await turn(f, 'a')).toBe('personal');
  f.runs.flush();
  const reread = new LoginRunLog(join(f.root, 'runs.json'), () => NOW);
  expect(reread.lastLogin('claude', 'a')).toBe(f.byName.personal!.id);
  expect(reread.recent('claude').map((r) => r.threadId)).toEqual(['a']);
});

test('the binding of a login does not change when it is renamed', () => {
  const f = fixture();
  const before = f.pool.bindingId('t', 'claude');
  f.logins[0]!.name = 'renamed';
  f.logins[1]!.name = 'renamed too';
  f.logins[2]!.name = 'renamed three';
  expect(f.pool.bindingId('t', 'claude')).toBe(before);
});

test('one login is the login: no ranking, no probe', async () => {
  const f = fixture();
  f.logins.splice(1);
  expect(await turn(f, 'a')).toBe('inixiative');
  expect(f.probes).toEqual([]);
  expect(f.pool.state({ from: 'default' }).balancing).toEqual({
    state: 'stopped',
    reason: 'one-login',
    on: 'inixiative',
  });
});

test('logins that report no usage (setup-token logins) are balanced by turns served instead', async () => {
  const f = fixture({ unread: ['inixiative', 'personal', 'work'] });
  const served = [];
  for (const thread of ['a', 'b', 'c', 'd', 'e', 'f']) served.push(await turn(f, thread));
  // Each new thread goes to the login that served the fewest turns in the last five hours.
  expect(served.sort()).toEqual([
    'inixiative',
    'inixiative',
    'personal',
    'personal',
    'work',
    'work',
  ]);
  const state = f.pool.state({ from: 'default' });
  expect(state.balancing).toEqual({
    state: 'balanced',
    across: 3,
    routing: 'quartile-balanced',
    by: 'turns',
  });
  expect(state.logins.map((l) => l.runs)).toEqual([2, 2, 2]);
});

test("this machine's own login keeps its native binding when it joins a pool or gets a name", async () => {
  const { sha256Hex } = await import('@inixiative/foundry-core');
  const { defaultProfileSource } = await import('../src/providers/default-profiles');
  const { NativeAuthentication } = await import('../src/providers/native-authentication');
  const own = defaultProfileSource('claude');
  // The binding every thread on ~/.claude has had: the thread, the source id and the source's hash.
  const before = `t:auth:${own.id}:${sha256Hex(JSON.stringify(own))}`;
  const binding = (source: NativeProfileSource) =>
    new NativeAuthentication({
      directory: '/tmp/foundry-binding',
      sources: [source],
      defaultSourceId: source.id,
    }).bindingId('t', 'claude');
  expect(binding(own)).toBe(before);
  expect(binding({ ...own, name: 'personal' })).toBe(before);
});

test('a burst of new threads on logins with no reading spreads out before any turn lands', async () => {
  const f = fixture({ unread: ['inixiative', 'personal', 'work'] });
  const launches = await Promise.all(['a', 'b', 'c'].map((t) => f.pool.prepare(t, 'claude')));
  expect(new Set(launches.map((l) => l.sourceId)).size).toBe(3);
  for (const launch of launches) launch.release();
});

test('a thread that moves and comes back starts fresh on its old login, never its stale session', async () => {
  const f = fixture({ used: { inixiative: 10, personal: 50, work: 60 } });
  expect(await turn(f, 'a')).toBe('inixiative');
  const first = f.pool.bindingId('a', 'claude');
  // Pinned to personal: thread a moves there, on a new binding.
  f.set({ pinned: true, preferredLoginId: f.byName.personal!.id });
  expect(await turn(f, 'a')).toBe('personal');
  // Balanced again, a stays where its session now lives.
  f.set({});
  expect(await turn(f, 'a')).toBe('personal');
  // Pinned back to inixiative: a returns, on a binding its old session there doesn't hold.
  f.set({ pinned: true, preferredLoginId: f.byName.inixiative!.id });
  expect(await turn(f, 'a')).toBe('inixiative');
  const back = f.pool.bindingId('a', 'claude');
  expect(back).not.toBe(first);
  expect(back.startsWith(first)).toBe(true);
  expect(f.runs.ofThread('a').map((r) => r.why)).toEqual(['balanced', 'moved', 'kept', 'moved']);
});

test('a lookup never chooses a login, and a login with a running launch reports it in use', async () => {
  const f = fixture({ used: { inixiative: 60, personal: 10, work: 60 } });
  // No launch yet: the primary's binding, nothing placed.
  expect(f.pool.bindingId('x', 'claude')).toContain(f.byName.inixiative!.id);
  const launch = await f.pool.prepare('x', 'claude');
  expect(launch.sourceId).toBe(f.byName.personal!.id);
  launch.launch(['claude'], {});
  expect(f.pool.inUse(f.byName.personal!.id)).toBe(1);
  launch.release();
  expect(f.pool.inUse(f.byName.personal!.id)).toBe(0);
});
