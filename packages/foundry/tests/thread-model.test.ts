import { afterEach, expect, test } from 'bun:test';
import type { ThreadMeta } from '@inixiative/foundry-core';
import { defaultThreadModel } from '../src/agents/thread-factory';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { ThreadLaunchSettings } from '../src/providers/thread-launch';
import {
  journalHistory,
  switchLine,
  WORKER_SWITCH_PHASE,
  type WorkerSwitchRecord,
} from '../src/turns/journal-history';
import { changeThreadModel } from '../src/turns/thread-model';
import { defaultConfig } from '../src/viewer/config';

/**
 * A thread holds the exact model it runs on (an alias is pinned to the id it points to), and only
 * `changeThreadModel` changes it after creation: behind a "Switched to" marker once it has run.
 */

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const fixture = () => {
  const store = new LocalSessionStore(':memory:');
  cleanup.push(() => store.close());
  const launch = new ThreadLaunchSettings();
  const thread = {
    id: 't',
    meta: {
      description: '',
      tags: [],
      status: 'idle',
      createdAt: 1,
      lastActiveAt: 1,
      worker: 'claude-code',
      model: { id: 'claude-opus-5-5', alias: 'opus' },
    } as ThreadMeta,
  };
  store.saveThread(thread);
  return { store, launch, thread, deps: { store, launch } };
};

test('a new thread pins the alias its settings name to the id it points to now', () => {
  const config = defaultConfig();
  config.defaults = { ...config.defaults, provider: 'claude-code', model: 'opus' };
  expect(defaultThreadModel(config)).toEqual({ id: 'claude-opus-5-5', alias: 'opus' });
  config.defaults.model = 'claude-fable-5-2';
  expect(defaultThreadModel(config)).toEqual({ id: 'claude-fable-5-2' });
});

test('before its first turn the model changes with no marker; after it, behind one, and the launch relaunches', () => {
  const { store, launch, thread, deps } = fixture();
  const revision = launch.forLaunch('t').revision;
  expect(changeThreadModel(deps, thread, { id: 'claude-fable-5-2' }, 'person')).toBeUndefined();
  expect(store.threadMeta('t')?.model).toEqual({ id: 'claude-fable-5-2' });
  expect(launch.forLaunch('t').revision).toBeGreaterThan(revision);

  store.beginTurn(thread, 'turn-1', 'hello');
  const marker = changeThreadModel(deps, thread, { id: 'claude-opus-5-5' }, 'retired');
  expect(marker).toMatchObject({
    from: 'claude-code',
    to: 'claude-code',
    fromModel: 'claude-fable-5-2',
    toModel: 'claude-opus-5-5',
    cause: 'retired',
  });
  expect(store.phasesOf('t', WORKER_SWITCH_PHASE).map((row) => row.record)).toEqual([
    expect.objectContaining({ toModel: 'claude-opus-5-5' }),
  ]);
  expect(store.threadMeta('t')?.model).toEqual({ id: 'claude-opus-5-5' });
  // The same model again writes nothing.
  expect(changeThreadModel(deps, thread, { id: 'claude-opus-5-5' }, 'person')).toBeUndefined();
  expect(store.phasesOf('t', WORKER_SWITCH_PHASE)).toHaveLength(1);
});

test('the store refuses a model change after the first turn without a recorded switch, and removing it always', () => {
  const { store, thread } = fixture();
  store.beginTurn(thread, 'turn-1', 'hello');
  thread.meta.model = { id: 'claude-fable-5-2' };
  expect(() => store.saveThread(thread)).toThrow('cannot change after its first turn');
  thread.meta.model = undefined;
  expect(() => store.saveThread(thread)).toThrow('cannot be removed');
});

test('a model-only switch reads "Switched to" and is no seed boundary; a worker move names its model', () => {
  const modelOnly: WorkerSwitchRecord = {
    from: 'claude-code',
    to: 'claude-code',
    fromLabel: 'Claude Code',
    toLabel: 'Claude Code',
    fromSession: null,
    fromModel: 'claude-fable-5-1',
    toModel: 'claude-fable-5-2',
    cause: 'retired',
  };
  expect(switchLine(modelOnly)).toBe(
    'Switched to claude-fable-5-2 from here (it ran on claude-fable-5-1 before, because claude-fable-5-1 was retired)',
  );
  expect(
    switchLine({
      ...modelOnly,
      to: 'codex',
      toLabel: 'Codex',
      toModel: 'gpt-6-astra',
      cause: 'person',
    }),
  ).toBe('Continued on Codex with gpt-6-astra from here (it ran on Claude Code before)');

  const { store, deps, thread } = fixture();
  store.beginTurn(thread, 'turn-1', 'Find me a role.');
  store.completeTurn(
    thread,
    'turn-1',
    'Watching.',
    {},
    {
      id: 'trace-1',
      messageId: 'turn-1',
      startedAt: 1,
      root: {},
      summary: { id: 'trace-1' },
      spans: [],
    },
  );
  changeThreadModel(deps, thread, { id: 'claude-fable-5-2' }, 'person');
  // The whole conversation is still the seed: the model switch did not start a new session.
  const seed = journalHistory(store, 't')!;
  expect(seed).toContain('Find me a role.');
  expect(seed).toContain('## Switched to claude-fable-5-2 from here');
});
