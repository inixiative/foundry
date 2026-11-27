import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { ProjectHostState } from '../src/providers/project-warden-hosts';
import { ConfigStore, starterConfig } from '../src/viewer/config';
import { registerWardenHostHealthRoutes } from '../src/viewer/routes/warden-host-health';
import { type WardenHostHealth, wardenHostHealth } from '../src/viewer/warden-host-health';
import { writeRegions } from './helpers/regions';

const host = (over: Partial<ProjectHostState> = {}): ProjectHostState => ({
  status: 'serving',
  expected: 3,
  held: 3,
  failures: 0,
  resets: {},
  generation: 1,
  ...over,
});

const on = { projectId: 'p', label: 'P', on: true, devMode: false } as const;
const now = new Date('2026-11-26T12:00:00Z');

describe('wardenHostHealth', () => {
  test('Layer 1 is the project entry, Layer 2 its lane entries, and the worst layer is the state', () => {
    const health = wardenHostHealth(
      [on],
      {
        p: host(),
        'p (claude-sonnet-5-5 at low)': host({
          lane: 'claude-sonnet-5-5 at low',
          held: 2,
          wardensDown: ['security'],
        }),
        // Another project's lane is never this one's.
        'q (claude-sonnet-5-5 at low)': host({
          lane: 'claude-sonnet-5-5 at low',
          status: 'failed',
        }),
      },
      now,
    );
    const [p] = health.projects;
    expect(p?.layer1?.state).toBe('ready');
    expect(p?.layer2.map((layer) => [layer.lane, layer.state])).toEqual([
      ['claude-sonnet-5-5 at low', 'degraded'],
    ]);
    expect(p?.state).toBe('degraded');
    expect(p?.ok).toBe(false);
    expect(health.ok).toBe(false);
    expect(health.checkedAt).toBe(now.toISOString());
  });

  test('a host not open yet rests, and resting or starting is healthy', () => {
    const resting = wardenHostHealth([on], {}, now).projects[0];
    expect(resting?.layer1).toMatchObject({ state: 'idle', status: 'not-open', held: 0 });
    expect(resting?.ok).toBe(true);
    const starting = wardenHostHealth(
      [on],
      { p: host({ status: 'starting', held: 0, reason: 'start' }) },
      now,
    );
    expect(starting.projects[0]?.state).toBe('working');
    expect(starting.ok).toBe(true);
  });

  test('a failed remote host is failed, and names the Chorus that served it', () => {
    const health = wardenHostHealth(
      [on],
      {
        p: host({
          status: 'failed',
          held: 0,
          failures: 2,
          reason: 'ECONNREFUSED',
          remote: 'http://127.0.0.1:1',
        }),
      },
      now,
    );
    expect(health.projects[0]).toMatchObject({
      remote: 'http://127.0.0.1:1',
      state: 'failed',
      ok: false,
      layer1: { status: 'failed', reason: 'ECONNREFUSED' },
    });
  });

  test('an off chorus is healthy with no layers, its reason kept', () => {
    const health = wardenHostHealth(
      [{ projectId: 'p', label: 'P', on: false, devMode: true, reason: 'not enabled' }],
      { p: host({ status: 'failed' }) },
      now,
    );
    expect(health.projects[0]).toEqual({
      projectId: 'p',
      label: 'P',
      on: false,
      devMode: true,
      reason: 'not enabled',
      layer2: [],
      state: 'idle',
      ok: true,
    });
    expect(health.ok).toBe(true);
  });
});

describe('GET /api/warden-hosts/health', () => {
  test('reads each project from settings, asks remotes only on fresh=1 and only for an on chorus', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'foundry-warden-host-health-'));
    try {
      const onPath = join(dir, 'on'),
        offPath = join(dir, 'off');
      writeRegions(onPath, [{ id: 'compatibility' }]);
      writeRegions(offPath, [{ id: 'testing' }], { enabled: false });
      const config = starterConfig('controlled', 'controlled');
      config.projects = {
        on: { id: 'on', path: onPath, label: 'On' },
        off: { id: 'off', path: offPath, __devMode: true },
      };
      const configStore = new ConfigStore(dir);
      await configStore.save(config);
      const checked: string[] = [];
      const app = new Hono();
      registerWardenHostHealthRoutes(app, {
        configStore,
        hosts: () => ({ projects: { on: host({ remote: 'kingdom:k.example' }) } }),
        check: async (projectId) => {
          checked.push(projectId);
        },
      });
      const read = async (query: string) =>
        (await (await app.request(`/api/warden-hosts/health${query}`)).json()) as WardenHostHealth;

      const all = await read('');
      expect(checked).toEqual([]);
      expect(all.ok).toBe(true);
      expect(all.projects.map((p) => [p.projectId, p.on, p.devMode])).toEqual([
        ['on', true, false],
        ['off', false, true],
      ]);
      expect(all.projects[0]).toMatchObject({ label: 'On', remote: 'kingdom:k.example' });
      expect(all.projects[1]?.reason).toBeString();

      const fresh = await read('?fresh=1');
      expect(checked).toEqual(['on']);
      expect(fresh.projects).toHaveLength(2);

      const one = await read('?project=off&fresh=1');
      expect(one.projects.map((p) => p.projectId)).toEqual(['off']);
      expect(checked).toEqual(['on']);

      const missing = await app.request('/api/warden-hosts/health?project=nope');
      expect(missing.status).toBe(404);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
