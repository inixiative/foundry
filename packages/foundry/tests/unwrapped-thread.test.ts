import { expect, test } from 'bun:test';
import {
  type CompletionOpts,
  ContextStack,
  Harness,
  type LLMMessage,
  type LLMProvider,
} from '@inixiative/foundry-core';
import { FOUNDRY_TOOLS_NOTE } from '../src/agents/chorus-reception';
import { FEEDBACK_BRIEF, SCOPE_BRIEF_LAYER } from '../src/agents/scope-roles';
import {
  buildAgents,
  buildLayers,
  type SourceResolver,
  ThreadFactory,
} from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { defaultAgents, type FoundryConfig, starterConfig } from '../src/viewer/config';

/** A fresh install: the starter config and its one executor, nothing else. */
function fresh(): FoundryConfig {
  const config = starterConfig('central', 'central-model');
  config.agents = defaultAgents();
  return config;
}

function harness(
  config: FoundryConfig,
  secretNote?: (messageId: string) => string | undefined,
  role?: string,
  threadWorker?: string,
) {
  const decisions: string[] = [];
  const central: Array<{ messages: LLMMessage[]; opts?: CompletionOpts }> = [];
  const decision: LLMProvider = {
    id: 'decisions',
    async complete(_messages, opts) {
      decisions.push(opts?.threadId ?? '');
      return { content: '{"layers":[],"domains":[],"confidence":1}', model: 'luna' };
    },
  };
  const worker: LLMProvider = {
    id: 'central',
    async complete(messages, opts) {
      central.push({ messages, opts });
      return { content: 'done', model: 'central-model' };
    },
  };
  const sourceResolver: SourceResolver = (id, cfg) =>
    cfg.sources[id] ? { id, load: async () => cfg.sources[id]!.uri } : null;
  const stack = new ContextStack(buildLayers(config, { sourceResolver }));
  const providers = new Map<string, LLMProvider>([
    [decision.id, decision],
    [worker.id, worker],
  ]);
  if (threadWorker) providers.set(threadWorker, { ...worker, id: threadWorker });
  const manager = new ThreadRuntimeManager({
    config,
    llm: decision,
    providers,
    ...(secretNote ? { secretNote } : {}),
    log() {},
    warn() {},
  });
  const deps = { provider: worker, providers };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(config, stack, deps),
    runtime: manager,
    configuration: { config, layers: { sourceResolver }, agents: deps },
  });
  const thread = factory.create('lead', {
    cwd: '/tmp',
    ...(role ? { role } : {}),
    ...(threadWorker ? { worker: threadWorker } : {}),
  });
  const h = new Harness(thread);
  h.setDefaultExecutor('executor');
  return { thread, harness: h, manager, decisions, central };
}

test('a fresh install has one executor that inherits the defaults, and no layers or sources', () => {
  const config = fresh();
  expect(Object.keys(config.agents)).toEqual(['executor']);
  expect(config.agents.executor).toMatchObject({ kind: 'executor', prompt: '', enabled: true });
  expect(config.agents.executor!.model).toBeUndefined();
  expect(config.agents.executor!.provider).toBeUndefined();
  expect(config.layers).toEqual({});
  expect(config.sources).toEqual({});
});

test('an unwrapped thread sends the message as typed with only the session briefing: no decision call, no other context, no thread-state', async () => {
  const { thread, harness: h, manager, decisions, central } = harness(fresh());
  try {
    const result = await h.send({ id: 'm1', payload: 'Add a login endpoint' });
    expect(result.result.output).toBe('done');
    // The trace is the turn arriving and the executor running: no classify or route stage.
    expect(result.classification ?? null).toBeNull();
    expect(result.route ?? null).toBeNull();
    expect(result.trace.summary().stages.map((stage) => stage.kind)).toEqual([
      'ingress',
      'execute',
    ]);
    expect(decisions).toEqual([]);
    expect(central).toHaveLength(1);
    expect(central[0]!.messages).toEqual([
      { role: 'system', content: FOUNDRY_TOOLS_NOTE },
      { role: 'user', content: 'Add a login endpoint' },
    ]);
    // A session provider would be handed the briefing to hold and nothing to send with the turn.
    expect(central[0]!.opts?.delivery?.standing.map((part) => part.id)).toEqual(['foundry-tools']);
    expect(central[0]!.opts?.delivery?.turn).toBe('');
    expect(thread.stack.layers.map((layer) => layer.id)).toEqual(['foundry-tools']);
    // No pre-message plan was sealed, so the turn records no routing.
    expect(result.result.meta?.phases).toEqual({ guards: [] });
  } finally {
    manager.disposeAll();
  }
});

test("a scope's thread holds its brief as a standing layer beside the session briefing, and stays unwrapped", async () => {
  const {
    thread,
    harness: h,
    manager,
    decisions,
    central,
  } = harness(fresh(), undefined, 'feedback');
  try {
    await h.send({ id: 'm1', payload: 'What is in the inbox?' });
    expect(decisions).toEqual([]);
    expect(central[0]!.opts?.delivery?.standing.map((part) => part.id)).toEqual([
      'foundry-tools',
      SCOPE_BRIEF_LAYER,
    ]);
    expect(central[0]!.opts?.delivery?.standing.at(-1)?.text).toContain(FEEDBACK_BRIEF.trim());
    expect(central[0]!.opts?.delivery?.turn).toBe('');
    // Held once: the next turn sends nothing new.
    await h.send({ id: 'm2', payload: 'Archive the first.' });
    expect(central[1]!.opts?.delivery?.turn).toBe('');
    expect(thread.stack.layers.map((layer) => layer.id)).toEqual([
      'foundry-tools',
      SCOPE_BRIEF_LAYER,
    ]);
  } finally {
    manager.disposeAll();
  }
});

test("the Forge Master's brief follows a settings edit on the next turn; a Feedback thread on Muse gets none", async () => {
  const config = fresh();
  const { harness: h, manager, central } = harness(config, undefined, 'forge-master');
  try {
    await h.send({ id: 'm1', payload: 'What is my default model?' });
    const first = central[0]!.opts?.delivery?.standing.find(
      (part) => part.id === SCOPE_BRIEF_LAYER,
    );
    expect(first?.text).toContain('Default executor: central/central-model');
    // Unchanged settings: nothing is sent again.
    await h.send({ id: 'm2', payload: 'And now?' });
    expect(central[1]!.opts?.delivery?.turn).toBe('');
    // An edit reaches the live thread's brief on its next turn.
    const edited = structuredClone(config);
    edited.defaults.model = 'edited-model';
    manager.reconfigure(edited);
    await h.send({ id: 'm3', payload: 'And after the edit?' });
    const delivery = central[2]!.opts?.delivery;
    const sent = [delivery?.turn ?? '', ...(delivery?.standing ?? []).map((part) => part.text)];
    expect(sent.some((text) => text.includes('Default executor: central/edited-model'))).toBe(true);
  } finally {
    manager.disposeAll();
  }
  // The Feedback brief names the inbox tools, which a Muse thread cannot hold.
  const muse = harness(fresh(), undefined, 'feedback', 'muse');
  try {
    expect(muse.thread.stack.layers.map((layer) => layer.id)).not.toContain(SCOPE_BRIEF_LAYER);
  } finally {
    muse.manager.disposeAll();
  }
});

test('an unwrapped thread still carries the secret reminder after the message, once, with no decision call', async () => {
  const notes = new Map([
    ['m1', 'Foundry: this message held a secret the person sent without $$.'],
  ]);
  const {
    harness: h,
    manager,
    decisions,
    central,
  } = harness(fresh(), (id) => {
    const note = notes.get(id);
    notes.delete(id);
    return note;
  });
  try {
    await h.send({ id: 'm1', payload: 'deploy with †m1.1' });
    await h.send({ id: 'm2', payload: 'and again' });
    expect(decisions).toEqual([]);
    expect(central[0]!.messages.at(-1)).toEqual({
      role: 'user',
      content:
        'deploy with †m1.1\n\n---\n\nFoundry: this message held a secret the person sent without $$.',
    });
    expect(central[1]!.messages.at(-1)).toEqual({ role: 'user', content: 'and again' });
  } finally {
    manager.disposeAll();
  }
});

test('a configured layer wraps the thread: the Cartographer routes and thread-state is assembled', async () => {
  const config = fresh();
  config.layers.rules = {
    id: 'rules',
    prompt: 'Project rules.',
    sourceIds: ['rules-src'],
    staleness: 0,
    enabled: true,
  };
  config.sources['rules-src'] = {
    id: 'rules-src',
    type: 'inline',
    label: 'Rules',
    uri: 'RULES_TEXT',
    enabled: true,
  };
  const { thread, harness: h, manager, decisions, central } = harness(config);
  try {
    for (const layer of thread.stack.layers) await layer.warm?.();
    await h.send({ id: 'm1', payload: 'Add a login endpoint' });
    expect(decisions.some((id) => id.endsWith(':cartographer'))).toBe(true);
    expect(thread.stack.layers.map((layer) => layer.id)).toEqual([
      'thread-state',
      'rules',
      'foundry-tools',
    ]);
    const system = central[0]!.messages.find((message) => message.role === 'system');
    expect(system?.content).toContain('RULES_TEXT');
  } finally {
    manager.disposeAll();
  }
});
