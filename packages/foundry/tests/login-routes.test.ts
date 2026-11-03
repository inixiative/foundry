import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { NativeProfileSource } from '../src/providers/default-profiles';
import { LoginPoolAuthentication, LoginRunLog, type PoolState } from '../src/providers/login-pool';
import { LoginSetup } from '../src/providers/login-setup';
import { SubscriptionAuthentication } from '../src/providers/subscription-authentication';
import { loginPoolSettings, usableLogins } from '../src/providers/subscription-policy';
import { ConfigStore, defaultConfig } from '../src/viewer/config';
import { registerLoginRoutes } from '../src/viewer/routes/logins';
import { subscriptionStatusProcess } from './helpers/subscription-transport';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'login-routes-'));
  roots.push(root);
  const login = (name: string): NativeProfileSource => {
    const profileDirectory = join(root, name);
    mkdirSync(profileDirectory, { mode: 0o700 });
    return {
      id: Bun.randomUUIDv7(),
      integrationId: Bun.randomUUIDv7(),
      runtime: 'claude',
      mode: 'native-profile',
      profileDirectory,
      name,
    };
  };
  const store = new ConfigStore(join(root, 'foundry'));
  const config = defaultConfig();
  config.nativeAuthentication = [login('inixiative'), login('personal'), login('work')];
  const projectId = Bun.randomUUIDv7();
  config.projects[projectId] = { id: projectId, label: 'Template', path: root };
  await store.save(config);
  const runs = new LoginRunLog();
  const pool = new LoginPoolAuthentication({
    runtime: 'claude',
    directory: join(root, 'runtime-profiles'),
    logins: () => usableLogins(store.config, 'claude').logins,
    primary: () => usableLogins(store.config, 'claude').primary,
    settings: () => loginPoolSettings(store.config, 'claude'),
    runs,
    own: () => false,
    probe: async (l) => ({
      runtime: 'claude',
      source: 'poll',
      observedAt: Date.now(),
      windows: [{ id: 'five_hour', usedPercent: l.name === 'work' ? 70 : 20, windowMinutes: 300 }],
    }),
    account: async (l) =>
      l.name === 'work'
        ? { plan: 'plan unknown' }
        : { plan: 'Claude Ultra (Max 20x)', account: `${l.name}@example.com` },
    authentication: (l) =>
      new SubscriptionAuthentication(join(root, 'runtime-profiles'), l, () =>
        subscriptionStatusProcess(),
      ),
  });
  const app = new Hono();
  registerLoginRoutes(app, {
    configStore: store,
    foundryDir: join(root, 'foundry'),
    pools: { claude: pool },
    runs,
    setup: new LoginSetup({ foundryDir: join(root, 'foundry'), store }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const pools = async (query = '') =>
    (await call('GET', `/api/providers/pools${query}`)).body as {
      pools: PoolState[];
      kingdom: unknown[];
    };
  return { store, pool, runs, call, pools, projectId, names: config.nativeAuthentication };
}

test('the pools read: balancing across the ready logins, each with its meters and turns', async () => {
  const f = await fixture();
  const launch = await f.pool.prepare('thread-1', 'claude');
  launch.admitted?.();
  launch.release();
  const { pools } = await f.pools();
  expect(pools).toHaveLength(1);
  const claude = pools[0]!;
  expect(claude.balancing).toEqual({
    state: 'balanced',
    across: 3,
    routing: 'quartile-balanced',
    by: 'usage',
  });
  expect(claude.logins.map((l) => [l.name, l.status, l.runs])).toEqual([
    ['inixiative', 'ready', 1],
    ['personal', 'ready', 0],
    ['work', 'ready', 0],
  ]);
  expect(claude.logins[0]!.limits?.windows[0]?.usedPercent).toBe(20);
  // Each login's plan and account as the provider tells it; "plan unknown" where it doesn't.
  expect(claude.logins.map((l) => [l.plan, l.account])).toEqual([
    ['Claude Ultra (Max 20x)', 'inixiative@example.com'],
    ['Claude Ultra (Max 20x)', 'personal@example.com'],
    ['plan unknown', undefined],
  ]);
  expect(claude.lastRuns.map((r) => r.name)).toEqual(['inixiative']);
  expect((await f.call('GET', '/api/providers/runs?thread=thread-1')).body.runs).toHaveLength(1);
});

test('the scale: pinned turns balancing off and says on which login; clearing turns it back on', async () => {
  const f = await fixture();
  const personal = f.names[1]!.id;
  expect(
    (
      await f.call('PATCH', '/api/providers/pools/claude', {
        pinned: true,
        preferredLoginId: personal,
      })
    ).status,
  ).toBe(200);
  expect((await f.pools()).pools[0]!.balancing).toEqual({
    state: 'stopped',
    reason: 'pinned',
    on: 'personal',
  });
  await f.call('PATCH', '/api/providers/pools/claude', { pinned: false });
  expect((await f.pools()).pools[0]!.balancing.state).toBe('balanced');
  // A project sets its own balancing, over the Foundry-wide one.
  await f.call('PATCH', '/api/providers/pools/claude', {
    routing: 'owner-first',
    preferredLoginId: personal,
    project: f.projectId,
  });
  const project = (await f.pools(`?project=${f.projectId}`)).pools[0]!;
  // The Foundry-wide view names the project that balances its own way.
  expect((await f.pools()).pools[0]!.overrides).toEqual([
    { projectId: f.projectId, name: 'Template' },
  ]);
  expect([project.routing, project.from, project.preferredLoginId]).toEqual([
    'owner-first',
    'project',
    personal,
  ]);
  // Refusals: an unknown routing, a login of no runtime here, an unpooled runtime.
  expect((await f.call('PATCH', '/api/providers/pools/claude', { routing: 'random' })).status).toBe(
    400,
  );
  expect(
    (
      await f.call('PATCH', '/api/providers/pools/claude', {
        preferredLoginId: Bun.randomUUIDv7(),
      })
    ).status,
  ).toBe(400);
  expect((await f.call('PATCH', '/api/providers/pools/claude', { routing: 'pinned' })).status).toBe(
    400,
  );
  expect((await f.call('PATCH', '/api/providers/pools/muse', { pinned: true })).status).toBe(400);
});

test('name and remove a login from the API', async () => {
  const f = await fixture();
  const work = f.names[2]!.id;
  expect((await f.call('PATCH', `/api/providers/logins/${work}`, { name: 'job' })).status).toBe(
    200,
  );
  expect((await f.pools()).pools[0]!.logins.map((l) => l.name)).toEqual([
    'inixiative',
    'personal',
    'job',
  ]);
  expect((await f.call('PATCH', `/api/providers/logins/${work}`, { name: '' })).status).toBe(400);
  // Whose subscription it is: set, shown, cleared.
  expect((await f.call('PATCH', `/api/providers/logins/${work}`, { owner: 'work' })).status).toBe(
    200,
  );
  expect((await f.pools()).pools[0]!.logins.find((l) => l.name === 'job')!.owner).toBe('work');
  await f.call('PATCH', `/api/providers/logins/${work}`, { owner: null });
  expect((await f.pools()).pools[0]!.logins.find((l) => l.name === 'job')!.owner).toBeUndefined();
  expect((await f.call('DELETE', `/api/providers/logins/${work}`)).status).toBe(200);
  expect((await f.pools()).pools[0]!.logins.map((l) => l.name)).toEqual(['inixiative', 'personal']);
});
