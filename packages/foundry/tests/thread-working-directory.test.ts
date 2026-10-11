import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
import type { ThreadJSON } from '../src/client';
import { createViewer } from '../src/viewer/server';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
};

/** A registered project that is a real git checkout with a linked worktree outside it, plus an unregistered directory. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'foundry-cwd-')));
  const project = join(root, 'app');
  const linked = join(root, 'app-feature');
  const outside = join(root, 'scratch');
  mkdirSync(project);
  mkdirSync(join(project, 'src'));
  mkdirSync(outside);
  git(project, 'init', '-q', '-b', 'main');
  git(
    project,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  git(project, 'worktree', 'add', '-q', '-b', 'feature', linked);

  const projects = new ProjectRegistry();
  projects.register({ id: 'app', label: 'App', path: project, tags: [], runtime: 'claude-code' });
  const viewer = createViewer({
    harness: new Harness(new Thread('main', new ContextStack())),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configDir: join(root, '.foundry'),
    projectRegistry: projects,
  });
  cleanup.push(async () => {
    await viewer.analyticsReady.catch(() => {});
    viewer.localStore?.close();
    rmSync(root, { force: true, recursive: true });
  });
  const create = async (body: Record<string, unknown>) => {
    const response = await viewer.app.request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as ThreadJSON & { error?: string },
    };
  };
  return { project, linked, outside, viewer, create };
}

test('a working directory inside a registered project belongs to that project', async () => {
  const f = fixture();
  const created = await f.create({ cwd: join(f.project, 'src'), tags: ['acp', 'acp:Paseo'] });
  expect(created.status).toBe(201);
  expect(created.body.meta).toMatchObject({
    projectId: 'app',
    cwd: join(f.project, 'src'),
    tags: ['acp', 'acp:Paseo'],
  });
  const listed = (await (await f.viewer.app.request('/api/threads?project=app')).json()) as {
    threads: ThreadJSON[];
  };
  expect(listed.threads.map((t: ThreadJSON) => t.threadId)).toContain(created.body.threadId);
});

test("a linked worktree of a registered checkout belongs to the checkout's project", async () => {
  const f = fixture();
  const created = await f.create({ cwd: f.linked });
  expect(created.status).toBe(201);
  expect(created.body.meta).toMatchObject({ projectId: 'app', cwd: f.linked });
});

test('a working directory outside every project is a global-scope thread, never refused', async () => {
  const f = fixture();
  const created = await f.create({ cwd: f.outside });
  expect(created.status).toBe(201);
  expect(created.body.meta.projectId).toBeUndefined();
  expect(created.body.meta.cwd).toBe(f.outside);
  const global = (await (await f.viewer.app.request('/api/threads')).json()) as {
    threads: ThreadJSON[];
  };
  expect(global.threads.map((t: ThreadJSON) => t.threadId)).toContain(created.body.threadId);

  const fetched = await f.viewer.app.request(`/api/threads/${created.body.threadId}`);
  expect(fetched.status).toBe(200);
  expect(((await fetched.json()) as ThreadJSON).threadId).toBe(created.body.threadId);
  expect((await f.viewer.app.request('/api/threads/nope')).status).toBe(404);
});

test('a relative working directory is refused', async () => {
  const f = fixture();
  const created = await f.create({ cwd: 'relative/path' });
  expect(created.status).toBe(400);
  expect(created.body.error).toContain('absolute');
});
