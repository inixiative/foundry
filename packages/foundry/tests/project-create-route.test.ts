import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { Hono } from 'hono';
import { ActionHandler } from '../src/viewer/actions';
import { ConfigStore, defaultAgents, starterConfig } from '../src/viewer/config';
import { resolveProjectView } from '../src/viewer/config-resolve';
import { registerControlRoutes } from '../src/viewer/routes/control';

test('an added project inherits global agents and layers and brings no sources of its own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-project-create-'));
  try {
    const repo = join(dir, 'repo');
    await mkdir(join(repo, 'docs'), { recursive: true });
    const config = starterConfig();
    config.agents = defaultAgents();
    const store = new ConfigStore(dir);
    await store.save(config);
    const main = new Thread('main', new ContextStack());
    const actions = new ActionHandler({
      harness: new Harness(main),
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      resolveThread: () => main,
    });
    const app = new Hono();
    registerControlRoutes(app, {
      harness: new Harness(main),
      actions,
      configStore: store,
      aiAssist: null,
      analyticsStore: null,
      actionQueue: null,
      tunnelHolder: { tunnel: null },
      port: 0,
      threadsChanged: () => {},
    });

    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repo, label: 'added' }),
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    const saved = await new ConfigStore(dir).load();
    const project = saved.projects[id]!;
    expect(project.agents).toBeUndefined();
    expect(project.layers).toBeUndefined();
    // A docs directory is not a source until the project adds one.
    expect(project.sources).toBeUndefined();

    const view = resolveProjectView(saved, id)!;
    expect(Object.keys(view.config.agents)).toEqual(['executor']);
    expect(view.config.sources).toEqual({});
    expect(view.layers).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
