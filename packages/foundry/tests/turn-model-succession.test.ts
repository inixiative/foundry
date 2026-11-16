import './helpers/isolate-archive';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeModelMissingError } from '@inixiative/agent-session';
import {
  ActionQueue,
  type CompletionOpts,
  ContextStack,
  EventStream,
  Executor,
  type FoundryModelInfo,
  type FoundryProviderInfo,
  Harness,
  InterventionLog,
  type LLMProvider,
  MODEL_REGISTRY,
  Thread,
} from '@inixiative/foundry-core';
import { Hono } from 'hono';
import { buildAgents, ThreadFactory } from '../src/agents/thread-factory';
import { ModelSuccession } from '../src/models/model-succession';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { ThreadLaunchSettings } from '../src/providers/thread-launch';
import { WORKER_SWITCH_PHASE } from '../src/turns/journal-history';
import { ConfigStore, defaultAgents } from '../src/viewer/config';
import { registerRuntimeRoutes } from '../src/viewer/routes/runtime';
import { ViewerThreadDirectory } from '../src/viewer/thread-directory';
import { withStreams } from './helpers/data-stream';

// A queued turn never starts on a retired model (Aron, 2026-11-15): at the front of the queue the
// thread moves to its successor, or, with none, the turn fails with the reason and never runs.

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const base = MODEL_REGISTRY['claude-code'] as FoundryProviderInfo;
const opus = base.models.find((model) => model.id === 'claude-opus-5-5') as FoundryModelInfo;
const registry: Record<string, FoundryProviderInfo> = {
  ...MODEL_REGISTRY,
  'claude-code': {
    ...base,
    models: [
      ...base.models,
      {
        ...opus,
        id: 'claude-opus-5-1',
        retired: { at: '2026-11-01', successor: 'claude-opus-5-5' },
      },
      { ...opus, id: 'claude-ancient', family: 'ancient', retired: { at: '2026-01-01' } },
      // Served by the registry, listed below Opus 5.5: an older Opus.
      { ...opus, id: 'claude-opus-5-3' },
    ],
  },
};

function daemon(model: string, fail?: (model: string | undefined) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'turn-succession-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const main = new Thread('main', new ContextStack(), {
    worker: 'claude-code',
    model: { id: model },
  });
  const ran: string[] = [];
  main.register(
    new Executor({
      id: 'worker',
      stack: main.stack,
      handler: async (_context, payload) => {
        ran.push(`${payload} on ${main.meta.model?.id}`);
        const failure = fail?.(main.meta.model?.id);
        if (failure) throw failure;
        return 'done';
      },
    }),
  );
  const harness = new Harness(main);
  harness.setDefaultExecutor('worker');
  const store = new LocalSessionStore(join(dir, 'sessions.sqlite'));
  cleanup.push(() => store.close());
  store.saveThread(main);
  const modelSuccession = new ModelSuccession({
    store,
    launch: new ThreadLaunchSettings(),
    registry,
  });
  const { turns } = registerRuntimeRoutes(
    new Hono(),
    withStreams({
      harness,
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      configStore: new ConfigStore(dir),
      localStore: store,
      modelSuccession,
    }),
  );
  return { turns, store, ran, main };
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5);
  expect(done()).toBe(true);
};

test('a turn on a retired model runs on its successor', async () => {
  const { turns, store, ran, main } = daemon('claude-opus-5-1');
  const accepted = turns.accept({ threadId: 'main', payload: 'A' });
  if (!accepted.ok) throw Error('not accepted');
  await until(() => store.turn(accepted.turnId)?.status === 'completed');
  expect(ran).toEqual(['A on claude-opus-5-5']);
  expect(main.meta.model).toEqual({ id: 'claude-opus-5-5' });
});

test('a turn on a retired model with no successor fails with the reason and never runs', async () => {
  const { turns, store, ran } = daemon('claude-ancient');
  const accepted = turns.accept({ threadId: 'main', payload: 'A' });
  if (!accepted.ok) throw Error('not accepted');
  await until(() => store.turn(accepted.turnId)?.status === 'failed');
  expect(ran).toEqual([]);
  expect(store.turn(accepted.turnId)?.error).toContain('claude-ancient was retired on 2026-01-01');
});

test('a thread unarchived on a retired model asks before its next turn, and runs on the answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-succession-revive-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const models: string[] = [];
  const provider: LLMProvider = {
    id: 'claude-code',
    async complete(_messages, opts?: CompletionOpts) {
      models.push(opts?.model ?? '');
      return { content: 'answered', model: opts?.model ?? '' };
    },
  };
  const configStore = new ConfigStore(dir);
  await configStore.update((draft) => {
    draft.agents = defaultAgents();
  });
  const config = configStore.config;
  const agentDeps = { provider, providers: new Map([['claude-code', provider]]) };
  const stack = new ContextStack();
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(config, stack, agentDeps),
    configuration: { config, layers: { sourceResolver: () => null }, agents: agentDeps },
  });
  const main = new Thread('main', new ContextStack(), {});
  const harness = new Harness(main);
  const directory = new ViewerThreadDirectory(main, undefined, factory);
  const store = new LocalSessionStore(join(dir, 'sessions.sqlite'));
  cleanup.push(() => store.close());
  const child = factory.create('child', {
    worker: 'claude-code',
    model: { id: 'claude-opus-5-1' },
  });
  directory.add(child);
  child.archive();
  store.saveThread(child);
  const queue = new ActionQueue();
  const launch = new ThreadLaunchSettings();
  const { turns } = registerRuntimeRoutes(
    new Hono(),
    withStreams({
      harness,
      directory,
      threadFactory: factory,
      threadLaunch: launch,
      eventStream: new EventStream(),
      interventions: new InterventionLog(),
      configStore,
      localStore: store,
      modelSuccession: new ModelSuccession({ store, launch, queue, registry }),
    }),
  );

  // Unarchived by the person (not by a message): the ask is held on the record.
  expect(turns.reopen('child')).toBe(true);
  expect(store.threadMeta('child')?.retiredModelChoice).toEqual({
    model: 'claude-opus-5-1',
    retiredAt: '2026-11-01',
  });
  const accepted = turns.accept({ threadId: 'child', payload: 'A' });
  if (!accepted.ok) throw Error('not accepted');
  await until(() => queue.pending().length === 1);
  expect(models).toEqual([]);
  queue.resolve(queue.pending()[0]?.id ?? '', 'claude-sonnet-5-5');
  await until(() => store.turn(accepted.turnId)?.status === 'completed');
  expect(models).toEqual(['claude-sonnet-5-5']);
  expect(directory.get('child')?.meta.model).toEqual({ id: 'claude-sonnet-5-5' });
});

const missingModel = (gone: string) => (model: string | undefined) =>
  model === gone
    ? Error('turn failed', {
        cause: new NativeModelMissingError('claude-code', gone, 'model_not_found'),
      })
    : undefined;

test('a turn the CLI refuses because the model does not exist moves the thread up its family, and says so', async () => {
  // The registry still serves it; only the CLI says it is gone.
  const { turns, store, main, ran } = daemon('claude-opus-5-3', missingModel('claude-opus-5-3'));
  const accepted = turns.accept({ threadId: 'main', payload: 'A' });
  if (!accepted.ok) throw Error('not accepted');
  await until(() => store.turn(accepted.turnId)?.status === 'failed');
  expect(store.turn(accepted.turnId)?.error).toBe(
    'claude-opus-5-3 is no longer served (the CLI says it does not exist). This thread now runs on claude-opus-5-5; send again.',
  );
  expect(main.meta.model).toEqual({ id: 'claude-opus-5-5' });
  const next = turns.accept({ threadId: 'main', payload: 'B' });
  if (!next.ok) throw Error('not accepted');
  await until(() => store.turn(next.turnId)?.status === 'completed');
  expect(ran).toEqual(['A on claude-opus-5-3', 'B on claude-opus-5-5']);
  expect(store.phasesOf('main', WORKER_SWITCH_PHASE).map((row) => row.record)).toEqual([
    expect.objectContaining({
      fromModel: 'claude-opus-5-3',
      toModel: 'claude-opus-5-5',
      cause: 'retired',
    }),
  ]);
});

test("another executor's missing model never moves the thread", async () => {
  const { turns, store, main } = daemon('claude-opus-5-3', () =>
    Error('turn failed', {
      cause: new NativeModelMissingError('codex-app-server', 'gpt-gone', 'model not found'),
    }),
  );
  const accepted = turns.accept({ threadId: 'main', payload: 'A' });
  if (!accepted.ok) throw Error('not accepted');
  await until(() => store.turn(accepted.turnId)?.status === 'failed');
  expect(store.turn(accepted.turnId)?.error).toBe('turn failed');
  expect(main.meta.model).toEqual({ id: 'claude-opus-5-3' });
});

test('when the newest of a family is gone, the thread never moves down: it asks for another model', async () => {
  const { turns, store, main } = daemon('claude-opus-5-5', missingModel('claude-opus-5-5'));
  const accepted = turns.accept({ threadId: 'main', payload: 'A' });
  if (!accepted.ok) throw Error('not accepted');
  await until(() => store.turn(accepted.turnId)?.status === 'failed');
  expect(store.turn(accepted.turnId)?.error).toContain('Choose another model for this thread');
  expect(main.meta.model).toEqual({ id: 'claude-opus-5-5' });
});

test('a turn failing for another reason keeps its model and its error', async () => {
  const { turns, store, main } = daemon('claude-opus-5-5', () => Error('plan limit reached'));
  const accepted = turns.accept({ threadId: 'main', payload: 'A' });
  if (!accepted.ok) throw Error('not accepted');
  await until(() => store.turn(accepted.turnId)?.status === 'failed');
  expect(store.turn(accepted.turnId)?.error).toContain('plan limit reached');
  expect(main.meta.model).toEqual({ id: 'claude-opus-5-5' });
});
