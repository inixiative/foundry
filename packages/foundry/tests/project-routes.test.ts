import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextStack,
  EventStream,
  Harness,
  InterventionLog,
  Thread,
} from '@inixiative/foundry-core';
import { ProjectRegistry } from '../src/agents/project';
import { createViewer } from '../src/viewer/server';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-project-routes-'));
  dirs.push(dir);
  const viewer = createViewer({
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: dir,
    localStore: null,
    projectRegistry: new ProjectRegistry(),
  });
  const request = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
    const response = await viewer.app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const saved = (id: string) =>
    JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).projects[id];
  return { dir, request, saved };
}

test('a project is renamed, archived and unarchived in place, and the change is saved', async () => {
  const f = fixture();
  const created = await f.request('/api/projects', { path: f.dir, label: 'Scratch' });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  const listed = async () =>
    (await f.request('/api/projects')).body.projects.find((p: { id: string }) => p.id === id);

  expect((await f.request(`/api/projects/${id}`, { label: '  Renamed ' }, 'PATCH')).status).toBe(
    200,
  );
  expect(await listed()).toMatchObject({ label: 'Renamed', status: 'idle' });

  expect(
    (await f.request(`/api/projects/${id}`, { status: 'archived' }, 'PATCH')).body,
  ).toMatchObject({ id, label: 'Renamed', status: 'archived', enabled: true });
  expect(await listed()).toMatchObject({ status: 'archived' });
  expect(f.saved(id)).toMatchObject({ label: 'Renamed', status: 'archived' });

  expect((await f.request(`/api/projects/${id}`, { status: 'active' }, 'PATCH')).status).toBe(200);
  expect(await listed()).toMatchObject({ status: 'idle' });
  expect(f.saved(id)).not.toHaveProperty('status');
});

test('a project patch refuses an empty label, an unknown status, an empty body and an unknown project', async () => {
  const f = fixture();
  const id = (await f.request('/api/projects', { path: f.dir })).body.id as string;
  for (const body of [{ label: '  ' }, { label: 7 }, { status: 'deleted' }, {}])
    expect((await f.request(`/api/projects/${id}`, body, 'PATCH')).status).toBe(400);
  expect((await f.request('/api/projects/proj_missing', { label: 'x' }, 'PATCH')).status).toBe(404);
});

test('a project’s steer setting (CORE-001): yours over the repository’s over Foundry’s, on by default', async () => {
  const f = fixture();
  const repo = mkdtempSync(join(tmpdir(), 'foundry-steer-repo-'));
  dirs.push(repo);
  const created = await f.request('/api/projects', { path: repo, label: 'Steer' });
  const id = created.body.id as string;
  const steer = async () => (await f.request(`/api/projects/${id}/steer`)).body;
  expect(await steer()).toMatchObject({
    steer: true,
    from: 'default',
    mine: null,
    repository: null,
  });

  // Foundry-wide off: the project follows it.
  expect((await f.request('/api/settings/threads', { steer: false }, 'PATCH')).status).toBe(200);
  expect(await steer()).toMatchObject({ steer: false, from: 'foundry', foundry: false });

  // For everyone: the repository's committed file.
  expect(
    (await f.request(`/api/projects/${id}/steer`, { scope: 'everyone', value: true }, 'PUT'))
      .status,
  ).toBe(200);
  expect(JSON.parse(readFileSync(join(repo, '.foundry/project.json'), 'utf8'))).toEqual({
    steer: true,
  });
  expect(await steer()).toMatchObject({ steer: true, from: 'repository', repository: true });

  // For me: this machine's project settings win.
  await f.request(`/api/projects/${id}/steer`, { scope: 'me', value: false }, 'PUT');
  expect(f.saved(id).steer).toBe(false);
  expect(await steer()).toMatchObject({ steer: false, from: 'settings', mine: false });
  await f.request(`/api/projects/${id}/steer`, { scope: 'me', value: null }, 'PUT');
  expect(await steer()).toMatchObject({ steer: true, from: 'repository', mine: null });

  expect(
    (await f.request(`/api/projects/${id}/steer`, { scope: 'team', value: true }, 'PUT')).status,
  ).toBe(400);
  expect(
    (await f.request(`/api/projects/${id}/steer`, { scope: 'me', value: 'yes' }, 'PUT')).status,
  ).toBe(400);
});
