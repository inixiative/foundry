import { expect, test } from 'bun:test';
import {
  type CompletionOpts,
  ContextStack,
  EventStream,
  Executor,
  Harness,
  InterventionLog,
  type LLMMessage,
  type LLMProvider,
  Thread,
  threadTitle,
} from '@inixiative/foundry-core';
import { Hono } from 'hono';
import {
  meaningfullyDifferent,
  NAMING_INSTRUCTIONS,
  ThreadNamer,
} from '../src/agents/thread-namer';
import { DECISION_PRIORITY } from '../src/providers/decision-priority';
import { ConfigStore } from '../src/viewer/config';
import { registerRuntimeRoutes } from '../src/viewer/routes/runtime';
import { withStreams } from './helpers/data-stream';

const exchange = (
  user = 'Fix the flaky login test',
  agent = 'Fixed the race in login.spec.ts',
) => ({
  user,
  agent,
});
const settle = () => Bun.sleep(5);

function namer(
  complete: LLMProvider['complete'],
  options: { quietMs?: number; minIntervalMs?: number; minTurns?: number } = {},
) {
  const thread = new Thread('t', new ContextStack(), { description: '', cwd: '/qa/project' });
  let changes = 0;
  const instance = new ThreadNamer({
    provider: { id: 'decisions', complete },
    changed: () => changes++,
    quietMs: 0,
    minIntervalMs: 0,
    minTurns: 1,
    ...options,
  });
  return { thread, namer: instance, changes: () => changes };
}

test('a human name is a hard override: no naming decision runs and the agent name never shows', async () => {
  let calls = 0;
  const f = namer(async () => {
    calls++;
    return { model: 'm', content: '{"title":"Agent title"}' };
  });
  f.thread.rename('My architecture work');
  f.namer.turnCompleted(f.thread, exchange());
  await settle();
  expect(calls).toBe(0);
  expect(threadTitle(f.thread.meta)).toEqual({ text: 'My architecture work', source: 'human' });
});

test('the first completed turn names the thread on an isolated, text-only, review-priority decision', async () => {
  let options: CompletionOpts | undefined;
  let input: LLMMessage[] = [];
  const f = namer(async (messages, opts) => {
    input = messages;
    options = opts;
    return { model: 'm', content: '{"title":"Fix flaky login test"}' };
  });
  f.namer.turnCompleted(f.thread, exchange());
  await settle();
  expect(options).toMatchObject({
    threadId: 't:aux:naming',
    cwd: '/qa/project',
    tools: false,
    maxTurns: 1,
    priority: DECISION_PRIORITY.review,
  });
  expect(input[0]).toEqual({ role: 'system', content: NAMING_INSTRUCTIONS });
  expect(input[1]!.content).toContain('Current name: (none)');
  expect(input[1]!.content).toContain('user: Fix the flaky login test');
  expect(f.thread.meta.agentName?.text).toBe('Fix flaky login test');
  expect(threadTitle(f.thread.meta)?.source).toBe('agent');
  expect(f.changes()).toBe(1);
});

test('clearing the human name shows the agent name again; a late decision never overwrites a human rename', async () => {
  let finish!: (value: { model: string; content: string }) => void;
  const f = namer(() => new Promise((resolve) => (finish = resolve)));
  f.thread.meta.agentName = { text: 'Old agent name', updatedAt: 1 };
  f.namer.turnCompleted(f.thread, exchange());
  await settle();
  f.thread.rename('Human renamed this');
  finish({ model: 'm', content: '{"title":"Completely different work"}' });
  await settle();
  expect(threadTitle(f.thread.meta)).toEqual({ text: 'Human renamed this', source: 'human' });
  expect(f.thread.meta.agentName?.text).toBe('Old agent name');
  f.thread.rename('');
  expect(threadTitle(f.thread.meta)).toEqual({ text: 'Old agent name', source: 'agent' });
});

test('churn guard: "keep" and near-identical titles leave the name alone; a real shift renames', async () => {
  const answers = [
    '{"keep":true}',
    '{"title":"Fix the flaky login tests"}',
    '{"title":"Billing export CSV"}',
  ];
  const f = namer(async () => ({ model: 'm', content: answers.shift()! }));
  f.thread.meta.agentName = { text: 'Fix flaky login test', updatedAt: 1 };
  for (let i = 0; i < 3; i++) {
    f.namer.turnCompleted(f.thread, exchange());
    await settle();
  }
  expect(answers).toHaveLength(0);
  expect(f.thread.meta.agentName?.text).toBe('Billing export CSV');
  expect(f.changes()).toBe(1);
  expect(meaningfullyDifferent('Fix flaky login test', 'Fix the flaky login tests')).toBe(false);
  expect(meaningfullyDifferent('Fix flaky login test', 'fix flaky login test')).toBe(false);
  expect(meaningfullyDifferent('Fix flaky login test', 'Fix flaky login test suite')).toBe(false);
  expect(meaningfullyDifferent(undefined, 'Anything')).toBe(true);
});

test('refresh trigger: a named thread is re-checked only after enough turns and time, once it goes quiet', async () => {
  let calls = 0;
  const f = namer(
    async () => {
      calls++;
      return { model: 'm', content: '{"keep":true}' };
    },
    { quietMs: 20, minIntervalMs: 60_000, minTurns: 3 },
  );
  f.thread.meta.agentName = { text: 'Fix flaky login test', updatedAt: Date.now() };
  for (let i = 0; i < 5; i++) f.namer.turnCompleted(f.thread, exchange());
  await Bun.sleep(40);
  expect(calls).toBe(0); // named a moment ago: the interval holds it back

  const g = namer(
    async () => {
      calls++;
      return { model: 'm', content: '{"keep":true}' };
    },
    { quietMs: 20, minIntervalMs: 60_000, minTurns: 3 },
  );
  g.thread.meta.agentName = { text: 'Fix flaky login test', updatedAt: Date.now() - 120_000 };
  g.namer.turnCompleted(g.thread, exchange());
  g.namer.turnCompleted(g.thread, exchange());
  await Bun.sleep(40);
  expect(calls).toBe(0); // two turns: not enough work since the last decision
  g.namer.turnCompleted(g.thread, exchange());
  g.namer.turnCompleted(g.thread, exchange()); // burst: the quiet timer restarts
  await Bun.sleep(5);
  expect(calls).toBe(0);
  await Bun.sleep(40);
  expect(calls).toBe(1);
  g.namer.turnCompleted(g.thread, exchange());
  await Bun.sleep(40);
  expect(calls).toBe(1); // just decided: the counters restarted
});

test('a failed or unparseable decision stays retryable on the next turn', async () => {
  let calls = 0;
  const f = namer(async () => {
    calls++;
    if (calls === 1) throw new Error('temporary provider failure');
    if (calls === 2) return { model: 'm', content: 'not json' };
    return { model: 'm', content: '{"title":"Recovered title"}' };
  });
  for (let i = 0; i < 3; i++) {
    f.namer.turnCompleted(f.thread, exchange());
    await settle();
  }
  expect(calls).toBe(3);
  expect(f.thread.meta.agentName?.text).toBe('Recovered title');
});

test('a naming decision does not mutate a disposed thread', async () => {
  let finish!: (value: { model: string; content: string }) => void;
  const f = namer(() => new Promise((resolve) => (finish = resolve)));
  f.namer.turnCompleted(f.thread, exchange());
  await settle();
  f.thread.dispose();
  finish({ model: 'm', content: '{"title":"Too late"}' });
  await settle();
  expect(f.thread.meta.agentName).toBeUndefined();
});

test('the message route feeds completed turns to the namer and a PATCH name overrides it', async () => {
  const stack = new ContextStack();
  const thread = new Thread('routed', stack, { description: 'Main conversation thread' });
  thread.register(new Executor({ id: 'worker', stack, handler: async () => 'done' }));
  const harness = new Harness(thread);
  harness.setDefaultExecutor('worker');
  const app = new Hono();
  const seen: Array<{ user: string; agent: string }> = [];
  const routed = new ThreadNamer({
    provider: {
      id: 'decisions',
      complete: async (messages) => {
        seen.push({ user: messages[1]!.content, agent: '' });
        return { model: 'm', content: '{"title":"Implement requested change"}' };
      },
    },
    changed: () => {},
  });
  registerRuntimeRoutes(
    app,
    withStreams({
      harness,
      eventStream: new EventStream(),
      interventions: new InterventionLog(thread.signals),
      db: null,
      configStore: new ConfigStore('/tmp/unused-naming-config'),
      namer: routed,
    }),
  );
  const response = await app.request('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Implement the requested change', threadId: 'routed' }),
  });
  expect(response.status).toBe(200);
  await settle();
  // A creation description does not block naming; the agent name takes over from it.
  expect(seen[0]!.user).toContain('user: Implement the requested change');
  expect(seen[0]!.user).toContain('agent: done');
  expect(threadTitle(thread.meta)).toEqual({ text: 'Implement requested change', source: 'agent' });

  const renamed = await app.request('/api/threads/routed', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Human name' }),
  });
  expect(((await renamed.json()) as { title: unknown }).title).toEqual({
    text: 'Human name',
    source: 'human',
  });
  const cleared = await app.request('/api/threads/routed', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: null }),
  });
  expect(((await cleared.json()) as { title: unknown }).title).toEqual({
    text: 'Implement requested change',
    source: 'agent',
  });
});
