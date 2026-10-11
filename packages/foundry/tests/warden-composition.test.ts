import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CompletionOpts,
  ContextStack,
  type LLMMessage,
  type LLMProvider,
} from '@inixiative/foundry-core';
import {
  buildAgents,
  buildLayers,
  type SourceResolver,
  ThreadFactory,
} from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import {
  type AgentSettingsConfig,
  ConfigStore,
  type FoundryConfig,
  starterConfig,
  validateConfig,
} from '../src/viewer/config';
import { resolveProjectView } from '../src/viewer/config-resolve';

const GLOBAL_RULES = 'GLOBAL_RULES: merge yourself once green.';

const warden = (): AgentSettingsConfig => ({
  id: 'conventions-warden',
  kind: 'decider',
  flowRole: 'domain-advising',
  domain: 'conventions',
  prompt: GLOBAL_RULES,
  provider: 'expert',
  model: 'warden-model',
  tools: false,
  visibleLayers: ['conventions'],
  ownedLayers: ['conventions'],
  peers: [],
  maxDepth: 1,
  enabled: true,
});

function config(): FoundryConfig {
  const c = starterConfig('central', 'central-model');
  c.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      prompt: 'WORKER_INSTRUCTIONS',
      provider: 'central',
      model: 'central-model',
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
    'conventions-warden': warden(),
  };
  c.layers = {
    conventions: {
      id: 'conventions',
      domain: 'conventions',
      segment: 'domain-knowledge',
      prompt: 'Conventions',
      sourceIds: ['global-conventions'],
      writers: ['conventions-warden'],
      staleness: 0,
      enabled: true,
    },
  };
  c.sources = {
    'global-conventions': {
      id: 'global-conventions',
      label: 'How I work',
      type: 'inline',
      uri: 'GLOBAL_KNOWLEDGE: look for what exists first.',
      enabled: true,
    },
  };
  c.projects.P = {
    id: 'P',
    path: '/controlled/P',
    sources: {
      'project-conventions': {
        id: 'project-conventions',
        label: 'Project CLAUDE.md',
        type: 'inline',
        uri: 'PROJECT_KNOWLEDGE: this repo runs on Bun.',
        enabled: true,
      },
    },
  };
  return c;
}

interface Call {
  phase: 'central' | 'pre' | 'post' | 'route';
  messages: LLMMessage[];
  opts: CompletionOpts;
}

function setup(c: FoundryConfig) {
  const calls: Call[] = [];
  const provider = (id: string): LLMProvider => ({
    id,
    async complete(messages, opts = {}) {
      const phase: Call['phase'] = opts.threadId?.endsWith(':cartographer')
        ? 'route'
        : opts.threadId?.includes(':review:')
          ? 'post'
          : opts.threadId?.includes(':aux:')
            ? 'pre'
            : 'central';
      calls.push({ phase, messages: structuredClone(messages), opts: { ...opts } });
      return {
        model: 'controlled',
        content:
          phase === 'central'
            ? 'done'
            : phase === 'route'
              ? JSON.stringify({ layers: ['conventions'], domains: [], confidence: 1 })
              : phase === 'pre'
                ? JSON.stringify({ layers: ['conventions'], snippets: [], confidence: 1 })
                : JSON.stringify({ decision: 'abstain', facts: [], reason: 'nothing new' }),
      };
    },
  });
  const central = provider('central'),
    flow = provider('flow'),
    expert = provider('expert');
  const providers = new Map([central, flow, expert].map((p) => [p.id, p]));
  const sourceResolver: SourceResolver = (id, cfg) =>
    cfg.sources[id] ? { id, load: async () => cfg.sources[id]!.uri } : null;
  const stack = new ContextStack(buildLayers(c, { sourceResolver }));
  const manager = new ThreadRuntimeManager({
    config: c,
    llm: flow,
    providers,
    log() {},
    warn() {},
    learning: { timeoutMs: 20, hardTimeoutMs: 1000 },
  });
  const deps = { provider: central, providers };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(c, stack, deps),
    runtime: manager,
    configuration: { config: c, layers: { sourceResolver }, agents: deps },
  });
  const last = (phase: Call['phase']) => calls.filter((call) => call.phase === phase).at(-1)!;
  return { factory, manager, calls, last };
}

const dirs: string[] = [];
const managers: ThreadRuntimeManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const runtime of manager.runtimes.values()) await runtime.learningSettled();
    manager.disposeAll();
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test('an extending project Warden appends its instructions under its own heading, global first', async () => {
  const c = config();
  c.projects.P!.agents = {
    'conventions-warden': { extends: 'conventions-warden', prompt: 'Use Bun' },
  };
  validateConfig(c);
  const view = resolveProjectView(c, 'P')!;
  const composed =
    '## Global instructions (conventions-warden)\n\nGLOBAL_RULES: merge yourself once green.\n\n## Project instructions (P)\n\nUse Bun';
  expect(view.config.agents['conventions-warden']!.prompt).toBe(composed);
  const agent = view.agents.find((a) => a.id === 'conventions-warden')!;
  expect(agent).toMatchObject({ scope: 'project-extension', extends: 'conventions-warden' });
  expect(agent.fields.prompt).toMatchObject({ origin: 'merged', strategy: 'extend' });
  expect(agent.fields.prompt!.chunks!.map((chunk) => [chunk.origin, chunk.from])).toEqual([
    ['global', 'conventions-warden'],
    ['project', 'P'],
  ]);
  // Everything else is the parent's.
  expect(view.config.agents['conventions-warden']).toMatchObject({
    kind: 'decider',
    domain: 'conventions',
    ownedLayers: ['conventions'],
    model: 'warden-model',
  });

  const f = setup(c);
  managers.push(f.manager);
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  await thread.dispatch('worker', 'Add a script');
  expect(f.last('pre').messages[0]!.content).toBe(composed);
});

test('override replaces the instructions chunk while domain knowledge still concatenates', async () => {
  const c = config();
  c.projects.P!.agents = {
    'conventions-warden': {
      extends: 'conventions-warden',
      prompt: 'Use Bun',
      domainKnowledge: ['project-conventions'],
      override: ['instructions'],
    },
  };
  validateConfig(c);
  const view = resolveProjectView(c, 'P')!;
  expect(view.config.agents['conventions-warden']!.prompt).toBe('Use Bun');
  const agent = view.agents.find((a) => a.id === 'conventions-warden')!;
  expect(agent.fields.prompt).toMatchObject({ origin: 'project', strategy: 'override' });
  expect(agent.fields.domainKnowledge).toMatchObject({ origin: 'merged', strategy: 'extend' });
  expect(view.config.layers.conventions!.sourceIds).toEqual([
    'global-conventions',
    'project-conventions',
  ]);

  const f = setup(c);
  managers.push(f.manager);
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  await thread.dispatch('worker', 'Add a script');
  const knowledge =
    '## Global domain knowledge (conventions)\n\nGLOBAL_KNOWLEDGE: look for what exists first.\n\n## Project domain knowledge (P)\n\nPROJECT_KNOWLEDGE: this repo runs on Bun.';
  expect(thread.stack.getLayer('conventions')!.content).toBe(knowledge);
  const pre = f.last('pre');
  expect(pre.messages[0]!.content).toBe('Use Bun');
  expect(pre.messages[1]!.content).toContain(knowledge);

  // Overriding domain knowledge keeps only the project chunk.
  c.projects.P!.agents['conventions-warden'] = {
    extends: 'conventions-warden',
    domainKnowledge: ['project-conventions'],
    override: ['domainKnowledge'],
  };
  const replaced = resolveProjectView(c, 'P')!;
  expect(replaced.config.layers.conventions!.sourceIds).toEqual(['project-conventions']);
  expect(replaced.config.agents['conventions-warden']!.prompt).toBe(GLOBAL_RULES);
});

test('without a project entry the global Warden applies unchanged', async () => {
  const c = config();
  validateConfig(c);
  const view = resolveProjectView(c, 'P')!;
  expect(view.config.agents['conventions-warden']).toEqual(c.agents['conventions-warden']!);
  expect(view.config.layers.conventions).toEqual(c.layers.conventions!);
  expect(view.agents.find((a) => a.id === 'conventions-warden')).toMatchObject({
    scope: 'global',
    fields: { prompt: { origin: 'global', strategy: 'inherit', resolvedValue: GLOBAL_RULES } },
  });

  const f = setup(c);
  managers.push(f.manager);
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  await thread.dispatch('worker', 'Add a script');
  expect(f.last('pre').messages[0]!.content).toBe(GLOBAL_RULES);
  expect(thread.stack.getLayer('conventions')!.content).toBe(
    'GLOBAL_KNOWLEDGE: look for what exists first.',
  );
});

test('project agents are standalone or extend a global agent; nothing in between', () => {
  const c = config();
  c.projects.P!.agents = { 'conventions-warden': { extends: 'missing' } };
  expect(() => validateConfig(c)).toThrow('is not a global agent');
  c.projects.P!.agents = {
    'conventions-warden': { extends: 'conventions-warden', override: ['instructions'] },
  };
  expect(() => validateConfig(c)).toThrow('overrides instructions without a prompt');
  c.projects.P!.agents = {
    'conventions-warden': {
      extends: 'conventions-warden',
      domainKnowledge: ['project-conventions'],
    },
  };
  c.projects.P!.layers = { conventions: { sourceIds: { append: ['project-conventions'] } } };
  expect(() => validateConfig(c)).toThrow('remove project.layers.conventions.sourceIds');
  c.projects.P!.layers = undefined;
  // A project-local version under another id supersedes its parent in that project.
  c.projects.P!.agents = { 'p-conventions': { extends: 'conventions-warden', prompt: 'Use Bun' } };
  const agents = resolveProjectView(c, 'P')!.config.agents;
  expect(agents['conventions-warden']).toBeUndefined();
  expect(agents['p-conventions']).toMatchObject({ id: 'p-conventions', domain: 'conventions' });
  // A standalone entry is a full definition.
  c.projects.P!.agents = { 'conventions-warden': { ...warden(), prompt: 'ONLY_P' } };
  expect(resolveProjectView(c, 'P')!.config.agents['conventions-warden']!.prompt).toBe('ONLY_P');
});

test('a settings edit reaches a running thread on its next turn, with a versioned before/after', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-live-settings-'));
  dirs.push(dir);
  const store = new ConfigStore(dir);
  await store.save(config());
  const f = setup(structuredClone(store.config));
  managers.push(f.manager);
  store.onChange((next) => f.factory.reconfigure(next));
  const thread = f.factory.create('main');

  await thread.dispatch('worker', 'First turn');
  expect(f.last('pre').messages[0]!.content).toBe(GLOBAL_RULES);
  expect(f.last('central').messages[0]!.content).toContain('WORKER_INSTRUCTIONS');

  await store.update((draft) => {
    draft.agents['conventions-warden']!.prompt = 'EDITED_RULES';
    draft.agents.worker!.prompt = 'EDITED_WORKER';
    draft.sources['global-conventions']!.uri = 'EDITED_KNOWLEDGE';
  });
  await store.settled();

  await thread.dispatch('worker', 'Second turn');
  const pre = f.last('pre');
  expect(pre.messages[0]!.content).toBe('EDITED_RULES');
  expect(pre.messages[1]!.content).toContain('EDITED_KNOWLEDGE');
  expect(f.last('central').messages[0]!.content).toContain('EDITED_WORKER');

  const [log] = await store.history('agent:conventions-warden');
  const edit = log!.entries.at(-1)!;
  expect(edit.author).toBe('user');
  expect(edit.snapshot.before).toMatchObject({ prompt: GLOBAL_RULES });
  expect(edit.snapshot.after).toMatchObject({ prompt: 'EDITED_RULES' });
  expect((await store.history()).map((l) => l.subject)).toEqual(
    expect.arrayContaining(['agent:worker', 'source:global-conventions']),
  );
});

test('the configured Cartographer instructions drive routing; runtime roles are never thread agents', async () => {
  const c = config();
  c.agents.cartographer = {
    id: 'cartographer',
    kind: 'cartographer',
    flowRole: 'context-routing',
    prompt: 'CARTOGRAPHER_INSTRUCTIONS',
    visibleLayers: [],
    peers: [],
    maxDepth: 1,
    enabled: true,
  };
  validateConfig(c);
  const f = setup(c);
  managers.push(f.manager);
  const thread = f.factory.create('main');
  expect(thread.getAgent('cartographer')).toBeUndefined();
  expect(thread.getAgent('conventions-warden')).toBeUndefined();
  await thread.dispatch('worker', 'Route me');
  const route = f.last('route');
  expect(route.messages[0]!.content).toBe('CARTOGRAPHER_INSTRUCTIONS');
  expect(route.messages[1]!.content).toContain('## Response protocol (routing)');

  for (const kind of ['librarian', 'herald']) {
    const bad = config();
    bad.agents[kind] = {
      ...c.agents.cartographer,
      id: kind,
      kind,
    } as unknown as AgentSettingsConfig;
    expect(() => validateConfig(bad)).toThrow('is not configurable');
  }
});
