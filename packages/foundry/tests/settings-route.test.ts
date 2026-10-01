import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextLayer,
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { Hono } from 'hono';
import { ActionHandler } from '../src/viewer/actions';
import { ConfigStore, starterConfig } from '../src/viewer/config';
import { registerControlRoutes } from '../src/viewer/routes/control';

test('reading settings and writing them back never persists runtime-generated layers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-settings-route-'));
  try {
    const store = new ConfigStore(dir);
    await store.save(starterConfig());
    const generated = new ContextLayer({
      id: 'thread-knowledge:docs',
      prompt: 'Generated',
      segment: 'thread-knowledge',
    });
    const main = new Thread('main', new ContextStack([generated]));
    const harness = new Harness(main);
    const actions = new ActionHandler({
      harness,
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      resolveThread: () => main,
    });
    const app = new Hono();
    registerControlRoutes(app, {
      harness,
      actions,
      configStore: store,
      aiAssist: null,
      analyticsStore: null,
      actionQueue: null,
      tunnelHolder: { tunnel: null },
      port: 0,
      threadsChanged: () => {},
    });

    const definitions = await (await app.request('/api/definitions')).json();
    expect(definitions.layers.map((l: { id: string }) => l.id)).toContain('thread-knowledge:docs');

    const settings = await (await app.request('/api/settings')).json();
    expect(Object.keys(settings.layers)).toEqual([]);
    const put = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings),
    });
    expect(put.status).toBe(200);
    await app.request('/api/settings/defaults', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: settings.defaults.model }),
    });

    expect(Object.keys((await new ConfigStore(dir).load()).layers)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('settings writes accept an optional expected revision and reject stale ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-settings-revision-'));
  try {
    const store = new ConfigStore(dir);
    await store.save(starterConfig());
    const main = new Thread('main', new ContextStack());
    const harness = new Harness(main);
    const actions = new ActionHandler({
      harness,
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      resolveThread: () => main,
    });
    const app = new Hono();
    registerControlRoutes(app, {
      harness,
      actions,
      configStore: store,
      aiAssist: null,
      analyticsStore: null,
      actionQueue: null,
      tunnelHolder: { tunnel: null },
      port: 0,
      threadsChanged: () => {},
    });
    const patch = (model: string, revision?: string) =>
      app.request('/api/settings/defaults', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          ...(revision ? { 'x-config-revision': revision } : {}),
        },
        body: JSON.stringify({ model }),
      });

    const read = await app.request('/api/settings');
    const revision = read.headers.get('x-config-revision')!;
    expect(revision).toBe(String(store.revision));
    const settings = await read.json();
    expect(settings.revision).toBeUndefined();

    const first = await patch('first', revision);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-config-revision')).toBe(String(Number(revision) + 1));
    expect((await patch('stale', revision)).status).toBe(409);
    expect(
      (
        await app.request('/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-config-revision': revision },
          body: JSON.stringify(settings),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request('/api/settings/layers/missing', {
          method: 'DELETE',
          headers: { 'x-config-revision': revision },
        })
      ).status,
    ).toBe(409);
    expect((await patch('bad', 'not-a-number')).status).toBe(400);
    expect(store.config.defaults.model).toBe('first');
    expect((await patch('unguarded')).status).toBe(200);
    expect((await new ConfigStore(dir).load()).defaults.model).toBe('unguarded');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
