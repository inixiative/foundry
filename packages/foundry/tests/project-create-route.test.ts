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
import {
  ConfigStore,
  defaultProjectAgents,
  defaultProjectLayers,
  starterConfig,
} from '../src/viewer/config';
import { resolveProjectView } from '../src/viewer/config-resolve';
import { registerControlRoutes } from '../src/viewer/routes/control';

test('an added project inherits global agents and layers and brings only its existing sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-project-create-'));
  try {
    const repo = join(dir, 'repo');
    await mkdir(join(repo, 'docs'), { recursive: true });
    const config = starterConfig();
    config.agents = defaultProjectAgents(config.defaults.provider, config.defaults.model);
    config.layers = defaultProjectLayers();
    const store = new ConfigStore(dir);
    await store.save(config);
    const main = new Thread('main', new ContextStack());
    const actions = new ActionHandler({
      harness: new Harness(main),
      eventStream: new EventStream(),
      interventions: new InterventionLog(main.signals),
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
    expect(Object.keys(project.sources!)).toEqual(['project-docs']);

    const view = resolveProjectView(saved, id)!;
    expect(view.config.agents.classifier!.visibleLayers).toEqual(['system']);
    expect(view.config.sources['project-docs']!.uri).toBe(join(repo, 'docs'));
    const layer = view.layers.find((l) => l.id === 'project')!;
    expect(layer.scope).toBe('global');
    expect(layer.config.sourceIds).toEqual(['project-docs', 'project-ai']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
