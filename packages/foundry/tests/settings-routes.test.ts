import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
import { registerArchiveRoutes } from '../src/archives/routes';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { startViewer } from '../src/viewer/server';
import { startFakeArchive } from './helpers/fake-archive';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function viewer() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-settings-routes-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const started = await startViewer({
    port: 0,
    configDir: dir,
    localStore: null,
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
  });
  cleanup.unshift(() => started.server.stop(true));
  return { dir, origin: `http://127.0.0.1:${started.server.port}` };
}

test('settings and analytics pages are served by path; unknown project paths are not', async () => {
  const { origin } = await viewer();
  for (const path of [
    '/settings',
    '/settings/providers',
    '/analytics',
    '/projects/p1/settings',
    '/projects/p1/settings/archive',
    '/projects/p1/analytics',
  ])
    expect({ path, status: (await fetch(`${origin}${path}`)).status }).toEqual({
      path,
      status: 200,
    });
  expect((await fetch(`${origin}/projects/p1/elsewhere`)).status).toBe(404);
});

test("removing a project's source deletes it from that project only, and refuses prototype keys", async () => {
  const { dir, origin } = await viewer();
  mkdirSync(join(dir, 'docs'));
  const project = (await (
    await fetch(`${origin}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir, label: 'Scratch' }),
    })
  ).json()) as { id: string; sources: Record<string, unknown> };
  const sourceId = Object.keys(project.sources)[0]!;
  const remove = (projectId: string, itemId: string) =>
    fetch(`${origin}/api/projects/${projectId}/settings/sources/${itemId}`, { method: 'DELETE' });

  for (const key of ['__proto__', 'constructor', 'toString'])
    expect({ key, status: (await remove(project.id, key)).status }).toEqual({ key, status: 404 });
  expect((await remove('constructor', sourceId)).status).toBe(404);

  const removed = await remove(project.id, sourceId);
  expect(removed.status).toBe(200);
  const config = (await (await fetch(`${origin}/api/settings`)).json()) as {
    projects: Record<string, { sources: Record<string, unknown> }>;
  };
  expect(Object.keys(config.projects[project.id]!.sources)).not.toContain(sourceId);
  expect((await remove(project.id, sourceId)).status).toBe(404);
});

test("a project's publish target is read from and set through the local Archive", async () => {
  const archive = startFakeArchive();
  cleanup.push(() => archive.stop());
  const journalDir = mkdtempSync(join(tmpdir(), 'foundry-destinations-'));
  const journal = new LocalSessionStore(join(journalDir, 'sessions.sqlite'));
  cleanup.push(() => {
    journal.close();
    rmSync(journalDir, { recursive: true, force: true });
  });
  const app = new Hono();
  const { capture } = registerArchiveRoutes(app, journal, new EventStream(), undefined, {
    connect: () => archive.client(),
  });
  cleanup.unshift(() => capture.close());
  const library = {
    integrationId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    name: 'inixiative',
  };
  const route = {
    projectId: 'p1',
    integrationId: library.integrationId,
    resourceId: library.resourceId,
  };
  const post = (action: string, body: unknown) =>
    app.request(`/api/archives/destinations/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  expect(await (await app.request('/api/archives/destinations?projectId=p1')).json()).toEqual({
    destinations: [],
    paired: false,
    libraries: [],
  });
  const refused = await post('connect', route);
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: string }).error).toContain('does not grant');

  archive.grantLibrary(library);
  expect((await post('connect', route)).status).toBe(200);
  const routed = (await (await app.request('/api/archives/destinations?projectId=p1')).json()) as {
    destinations: Array<{ resourceId: string; pending: number }>;
    paired: boolean;
  };
  expect(routed.paired).toBe(true);
  expect(routed.destinations.map((d) => d.resourceId)).toEqual([library.resourceId]);

  expect(await (await post('remove', route)).json()).toEqual({ removed: true });
  expect((await post('connect', { ...route, integrationId: 'not-a-uuid' })).status).toBe(400);
});
