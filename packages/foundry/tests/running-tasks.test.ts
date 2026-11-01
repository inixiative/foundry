import { afterEach, expect, test } from 'bun:test';
import type { NativeEvidence, NativeOwner, ThreadMeta } from '@inixiative/foundry-core';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { RunningTasks } from '../src/turns/running-tasks';

const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});

function journal() {
  const store = new LocalSessionStore(':memory:');
  closes.push(() => store.close());
  const thread = {
    id: 'main',
    meta: {
      description: 'Main',
      tags: [],
      status: 'active',
      createdAt: 1,
      lastActiveAt: 1,
    } satisfies ThreadMeta,
  };
  store.saveThread(thread);
  store.beginTurn(thread, 'turn-1', 'Run the dev server');
  store.startTurn(thread, 'turn-1');
  const owner: NativeOwner = {
    threadId: 'main',
    messageId: 'turn-1',
    generation: 'g1',
    dispatchId: 'd1',
  };
  const base = { schema: 1 as const, owner, admissionId: 'adm-1' };
  store.registerNative(thread, { ...base, nativeOutcome: 'unknown' } satisfies NativeEvidence);
  store.appendNative(thread, {
    ...base,
    nativeOutcome: 'unknown',
    kind: 'tool_use',
    callId: 'toolu_dev',
    toolName: 'Bash',
    toolInput: {
      command: 'bun run dev',
      description: 'Start the dev server',
      run_in_background: true,
    },
  } satisfies NativeEvidence);
  return store;
}

test("a background shell is listed with its starting call's command and label until it ends", async () => {
  const store = journal();
  const tasks = new RunningTasks((threadId, callId) => store.nativeToolUse(threadId, callId));
  const stops: string[] = [];
  tasks.observe(
    'main',
    { phase: 'started', taskId: 'shell-1', taskType: 'local_bash', toolUseId: 'toolu_dev' },
    100,
    async () => {
      stops.push('shell-1');
    },
  );
  expect(tasks.list('main')).toEqual([
    {
      taskId: 'shell-1',
      taskType: 'local_bash',
      state: 'running',
      command: 'bun run dev',
      label: 'Start the dev server',
      toolUseId: 'toolu_dev',
      startedAt: 100,
      endedAt: null,
      summary: null,
      stoppable: true,
    },
  ]);
  expect(await tasks.stop('main', 'shell-1')).toBe('stopping');
  expect(stops).toEqual(['shell-1']);
  tasks.observe(
    'main',
    { phase: 'ended', taskId: 'shell-1', taskType: 'local_bash', status: 'stopped' },
    200,
  );
  expect(tasks.list('main')[0]).toMatchObject({ state: 'stopped', endedAt: 200, stoppable: false });
  expect(await tasks.stop('main', 'shell-1')).toBe('ended');
  expect(await tasks.stop('main', 'nope')).toBe('not-found');
  expect(tasks.list('other')).toEqual([]);
});

test('a task whose runtime cannot stop it says so', async () => {
  const tasks = new RunningTasks();
  tasks.observe(
    'main',
    { phase: 'started', taskId: 'm-1', taskType: 'monitor', description: 'watch CI' },
    5,
  );
  expect(tasks.list('main')[0]).toMatchObject({
    label: 'watch CI',
    command: null,
    stoppable: false,
  });
  expect(await tasks.stop('main', 'm-1')).toBe('unsupported');
});
