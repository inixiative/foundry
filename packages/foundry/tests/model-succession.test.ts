import { afterEach, expect, test } from 'bun:test';
import {
  ActionQueue,
  type FoundryModelInfo,
  type FoundryProviderInfo,
  MODEL_REGISTRY,
  type ThreadMeta,
} from '@inixiative/foundry-core';
import {
  MODEL_SUCCESSION_AUTHOR,
  ModelSuccession,
  settingSuccessions,
} from '../src/models/model-succession';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { ThreadLaunchSettings } from '../src/providers/thread-launch';
import { WORKER_SWITCH_PHASE } from '../src/turns/journal-history';
import { type AgentSettingsConfig, defaultConfig, type FoundryConfig } from '../src/viewer/config';

/**
 * Retired models (Aron, 2026-11-15): open threads move to the newest model of their family on
 * their worker, behind a marker; a revived thread asks; settings move in one audited update.
 */

const base = MODEL_REGISTRY['claude-code'] as FoundryProviderInfo;
const opus = base.models.find((model) => model.id === 'claude-opus-5-5') as FoundryModelInfo;
const retiredModels: FoundryModelInfo[] = [
  // Retired twice: its successor is retired too, so it moves to the end of the chain.
  {
    ...opus,
    id: 'claude-opus-4-9',
    label: 'Opus 4.9',
    retired: { at: '2026-10-01', successor: 'claude-opus-5-1' },
  },
  {
    ...opus,
    id: 'claude-opus-5-1',
    label: 'Opus 5.1',
    retired: { at: '2026-11-01', successor: 'claude-opus-5-5' },
  },
  {
    ...opus,
    id: 'claude-ancient',
    label: 'Ancient',
    family: 'ancient',
    retired: { at: '2026-01-01' },
  },
];
const registry: Record<string, FoundryProviderInfo> = {
  ...MODEL_REGISTRY,
  'claude-code': { ...base, models: [...base.models, ...retiredModels] },
};

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const fixture = (model: ThreadMeta['model'], extra: Partial<ThreadMeta> = {}) => {
  const store = new LocalSessionStore(':memory:');
  cleanup.push(() => store.close());
  const launch = new ThreadLaunchSettings();
  const queue = new ActionQueue();
  const thread = {
    id: 't',
    meta: {
      description: '',
      tags: [],
      status: 'idle',
      createdAt: 1,
      lastActiveAt: 1,
      worker: 'claude-code',
      model,
      ...extra,
    } as ThreadMeta,
  };
  store.saveThread(thread);
  store.beginTurn(thread, 'turn-0', 'earlier work');
  store.failTurn(thread, 'turn-0', 'earlier work ended');
  const succession = new ModelSuccession({ store, launch, queue, registry });
  return { store, launch, queue, thread, succession };
};

test('an open thread on a retired model moves to the end of its successor chain, behind a marker', async () => {
  const { store, thread, succession } = fixture({ id: 'claude-opus-4-9' });
  expect(await succession.beforeTurn(thread, 'turn-1')).toBeNull();
  expect(thread.meta.model).toEqual({ id: 'claude-opus-5-5' });
  expect(store.phasesOf('t', WORKER_SWITCH_PHASE).map((row) => row.record)).toEqual([
    expect.objectContaining({
      from: 'claude-code',
      to: 'claude-code',
      fromModel: 'claude-opus-4-9',
      toModel: 'claude-opus-5-5',
      cause: 'retired',
    }),
  ]);
  // A served model is never moved.
  expect(await succession.beforeTurn(thread, 'turn-2')).toBeNull();
  expect(store.phasesOf('t', WORKER_SWITCH_PHASE)).toHaveLength(1);
});

test('the alias is kept when it now points to the successor', async () => {
  const { thread, succession } = fixture({ id: 'claude-opus-5-1', alias: 'opus' });
  await succession.beforeTurn(thread, 'turn-1');
  expect(thread.meta.model).toEqual({ id: 'claude-opus-5-5', alias: 'opus' });
});

test('a retired model with no successor refuses the turn and stays', async () => {
  const { thread, succession } = fixture({ id: 'claude-ancient' });
  expect(await succession.beforeTurn(thread, 'turn-1')).toContain(
    'claude-ancient was retired on 2026-01-01',
  );
  expect(thread.meta.model).toEqual({ id: 'claude-ancient' });
});

test('a thread revived from archive on a retired model asks, successor first, and moves to the answer', async () => {
  const { queue, thread, succession } = fixture({ id: 'claude-opus-5-1' });
  succession.revived(thread);
  expect(thread.meta.retiredModelChoice).toEqual({
    model: 'claude-opus-5-1',
    retiredAt: '2026-11-01',
  });
  const turn = succession.beforeTurn(thread, 'turn-1');
  const [prompt] = queue.pending();
  expect(prompt).toMatchObject({ kind: 'choice', threadId: 't', meta: { structural: true } });
  expect(prompt?.options?.[0]).toMatchObject({ id: 'claude-opus-5-5' });
  expect(
    prompt?.options?.some((option) => option.id === 'opus' || option.id === 'claude-opus-5-1'),
  ).toBe(false);
  queue.resolve(prompt?.id ?? '', 'claude-sonnet-5-5');
  expect(await turn).toBeNull();
  expect(thread.meta.model).toEqual({ id: 'claude-sonnet-5-5' });
  expect(thread.meta.retiredModelChoice).toBeUndefined();
});

test('the ask survives a restart: the boot sweep leaves the thread and its next turn still asks', async () => {
  const { store, launch, thread, succession } = fixture({ id: 'claude-opus-5-1' });
  succession.revived(thread);
  store.saveThread(thread);
  // The next boot: a new succession over the saved record.
  const saved = { id: 't', meta: store.threadMeta('t') as ThreadMeta };
  const queue = new ActionQueue();
  const next = new ModelSuccession({ store, launch, queue, registry });
  expect(next.moveIdle(saved)).toBe(false);
  void next.beforeTurn(saved, 'turn-1');
  expect(queue.pending()).toHaveLength(1);
  next.release('turn-1');
  expect(saved.meta.model).toEqual({ id: 'claude-opus-5-1' });
});

test('a revive prompt withdrawn (the turn was stopped) refuses, and the next turn asks again', async () => {
  const { queue, thread, succession } = fixture({ id: 'claude-opus-5-1' });
  succession.revived(thread);
  const turn = succession.beforeTurn(thread, 'turn-1');
  succession.release('turn-1');
  expect(await turn).toContain('waits for its model to be chosen');
  expect(thread.meta.model).toEqual({ id: 'claude-opus-5-1' });
  void succession.beforeTurn(thread, 'turn-2');
  expect(queue.pending()).toHaveLength(1);
  succession.release('turn-2');
});

test('at boot an idle open thread moves; an archived one stays', () => {
  const open = fixture({ id: 'claude-opus-5-1' });
  expect(open.succession.moveIdle(open.thread)).toBe(true);
  expect(open.thread.meta.model).toEqual({ id: 'claude-opus-5-5' });
  // A turn still open (cut by the restart) is left for recovery and its own next turn.
  const cut = fixture({ id: 'claude-opus-5-1' });
  cut.store.beginTurn(cut.thread, 'turn-1', 'cut by the restart');
  expect(cut.succession.moveIdle(cut.thread)).toBe(false);
  const archived = fixture({ id: 'claude-opus-5-1' }, { archivedAt: 5 });
  expect(archived.succession.moveIdle(archived.thread)).toBe(false);
  expect(archived.thread.meta.model).toEqual({ id: 'claude-opus-5-1' });
});

test('settings naming a retired model move in one update audited as model succession', async () => {
  const config = defaultConfig();
  config.defaults = { ...config.defaults, provider: 'claude-code', model: 'claude-opus-4-9' };
  const executor = (id: string, model: string): AgentSettingsConfig => ({
    id,
    kind: 'executor',
    prompt: '',
    provider: 'claude-code',
    model,
    visibleLayers: [],
    peers: [],
    maxDepth: 1,
    enabled: true,
  });
  config.agents = {
    ...config.agents,
    old: executor('old', 'claude-opus-5-1'),
    gone: executor('gone', 'claude-ancient'),
  };
  expect(settingSuccessions(config, registry)).toEqual(
    expect.arrayContaining([
      {
        path: 'defaults.model',
        provider: 'claude-code',
        from: 'claude-opus-4-9',
        to: 'claude-opus-5-5',
      },
      {
        path: 'agents.old.model',
        provider: 'claude-code',
        from: 'claude-opus-5-1',
        to: 'claude-opus-5-5',
      },
      expect.objectContaining({
        path: 'agents.gone.model',
        from: 'claude-ancient',
        reason: expect.any(String),
      }),
    ]),
  );
  // A model key is read against its paired provider key, not the default provider.
  const paired = structuredClone(config);
  paired.defaults = {
    ...paired.defaults,
    provider: 'codex',
    model: 'gpt-6-astra',
    classifierProvider: 'claude-code',
    classifierModel: 'claude-opus-5-1',
  };
  expect(settingSuccessions(paired, registry)).toContainEqual({
    path: 'defaults.classifierModel',
    provider: 'claude-code',
    from: 'claude-opus-5-1',
    to: 'claude-opus-5-5',
  });
  const authors: string[] = [];
  const store = {
    config,
    async update(
      fn: (draft: FoundryConfig) => FoundryConfig | void,
      _revision: undefined,
      author: string,
    ) {
      authors.push(author);
      const draft = structuredClone(store.config);
      store.config = fn(draft) ?? draft;
    },
  };
  const { succession } = fixture({ id: 'claude-opus-5-5' });
  await succession.succeedSettings(store);
  expect(authors).toEqual([MODEL_SUCCESSION_AUTHOR]);
  expect(store.config.defaults.model).toBe('claude-opus-5-5');
  expect(store.config.agents.old?.model).toBe('claude-opus-5-5');
  expect(store.config.agents.gone?.model).toBe('claude-ancient');
  // Nothing left to move: no second update.
  await succession.succeedSettings(store);
  expect(authors).toHaveLength(1);
});
