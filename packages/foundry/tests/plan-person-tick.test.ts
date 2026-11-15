import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { recordPlan } from '../src/tools/thread-record';
import { ConfigStore } from '../src/viewer/config';
import { registerRuntimeRoutes } from '../src/viewer/routes/runtime';
import { withStreams } from './helpers/data-stream';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-plan-tick-'));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const thread = new Thread('main', new ContextStack(), { description: 'Grouped work' });
  cleanup.push(() => thread.dispose());
  recordPlan(thread, {
    outcomes: [
      { text: 'Alpha outcome', status: 'todo', group: 'First group' },
      { text: 'Beta outcome', status: 'todo' },
    ],
  });
  const app = new Hono();
  const deps = withStreams({
    harness: new Harness(thread),
    eventStream: new EventStream(),
    interventions: new InterventionLog(),
    configStore: new ConfigStore(dir),
  });
  registerRuntimeRoutes(app, deps);
  const patch = (id: string, body: unknown) =>
    app.request(`/api/threads/${id}/plan`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { thread, patch };
}

test('a person ticks a grouped outcome in the panel route: no milestone, group kept', async () => {
  const { thread, patch } = setup();
  const response = await patch('main', { outcome: 'Alpha outcome', status: 'done' });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    meta: { plan: { outcomes: Array<{ text: string; status: string; group?: string }> } };
  };
  expect(body.meta.plan.outcomes[0]).toMatchObject({
    text: 'Alpha outcome',
    status: 'done',
    group: 'First group',
  });
  expect(thread.meta.plan?.outcomes[0]?.status).toBe('done');
  // A person's tick never shows the thread done the way an agent's milestone does.
  expect(thread.meta.done).toBeUndefined();
  // Unticking returns it to todo, still with no milestone.
  const back = await patch('main', { outcome: 'Alpha outcome', status: 'todo' });
  expect(back.status).toBe(200);
  expect(thread.meta.plan?.outcomes[0]?.status).toBe('todo');
  expect(thread.meta.done).toBeUndefined();
});

test('the plan route refuses a missing thread, a bad mark, and a disposed thread', async () => {
  const { thread, patch } = setup();
  expect((await patch('missing', { outcome: 'Alpha outcome', status: 'done' })).status).toBe(404);
  expect((await patch('main', { outcome: 'No such outcome', status: 'done' })).status).toBe(400);
  expect((await patch('main', { outcome: 'Alpha outcome', status: 'bogus' })).status).toBe(400);
  expect((await patch('main', {})).status).toBe(400);
  thread.dispose();
  expect((await patch('main', { outcome: 'Alpha outcome', status: 'done' })).status).toBe(409);
});
