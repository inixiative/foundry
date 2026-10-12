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
import { configuredExperts } from '../src/agents/configured-experts';
import {
  buildAgents,
  buildLayers,
  type SourceResolver,
  ThreadFactory,
} from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { chartered } from '../src/agents/warden-charter';
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
  visibleLayers: [],
  domainKnowledge: ['global-conventions'],
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
  c.layers = {};
  // Only settings compose here: no instruction files from the machine running the tests.
  c.composition = { preset: 'none' };
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
                : 'NO_COMMENT',
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
    domainKnowledge: ['global-conventions'],
    model: 'warden-model',
  });

  const f = setup(c);
  managers.push(f.manager);
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  await thread.dispatch('worker', 'Add a script');
  expect(f.last('pre').messages[0]!.content).toBe(chartered(composed));
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
  expect(view.config.agents['conventions-warden']!.domainKnowledge).toEqual([
    'global-conventions',
    'project-conventions',
  ]);

  const f = setup(c);
  managers.push(f.manager);
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  await thread.dispatch('worker', 'Add a script');
  const knowledge =
    '## How I work\n\nGLOBAL_KNOWLEDGE: look for what exists first.\n\n## Project CLAUDE.md\n\nPROJECT_KNOWLEDGE: this repo runs on Bun.';
  const lib = f.manager.get(thread.id)!.domainLibrarians.get('conventions')!;
  expect(lib.cache.content).toBe(knowledge);
  const pre = f.last('pre');
  expect(pre.messages[0]!.content).toBe(chartered('Use Bun'));
  expect(pre.messages[1]!.content).toContain(knowledge);

  // Overriding domain knowledge keeps only the project chunk.
  c.projects.P!.agents['conventions-warden'] = {
    extends: 'conventions-warden',
    domainKnowledge: ['project-conventions'],
    override: ['domainKnowledge'],
  };
  const replaced = resolveProjectView(c, 'P')!;
  expect(replaced.config.agents['conventions-warden']!.domainKnowledge).toEqual([
    'project-conventions',
  ]);
  expect(replaced.config.agents['conventions-warden']!.prompt).toBe(GLOBAL_RULES);
});

test('without a project entry the global Warden applies unchanged', async () => {
  const c = config();
  validateConfig(c);
  const view = resolveProjectView(c, 'P')!;
  expect(view.config.agents['conventions-warden']).toEqual(c.agents['conventions-warden']!);
  expect(view.agents.find((a) => a.id === 'conventions-warden')).toMatchObject({
    scope: 'global',
    fields: { prompt: { origin: 'global', strategy: 'inherit', resolvedValue: GLOBAL_RULES } },
  });

  const f = setup(c);
  managers.push(f.manager);
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  await thread.dispatch('worker', 'Add a script');
  expect(f.last('pre').messages[0]!.content).toBe(chartered(GLOBAL_RULES));
  expect(f.manager.get(thread.id)!.domainLibrarians.get('conventions')!.cache.content).toBe(
    '## How I work\n\nGLOBAL_KNOWLEDGE: look for what exists first.',
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
  // A project-local version under another id supersedes its parent in that project.
  c.projects.P!.agents = { 'p-conventions': { extends: 'conventions-warden', prompt: 'Use Bun' } };
  const superseded = resolveProjectView(c, 'P')!.config;
  expect(superseded.agents['conventions-warden']).toBeUndefined();
  expect(superseded.agents['p-conventions']).toMatchObject({
    id: 'p-conventions',
    domain: 'conventions',
  });
  expect(configuredExperts(superseded).experts.map((e) => e.agentId)).toEqual(['p-conventions']);
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
  expect(f.last('pre').messages[0]!.content).toBe(chartered(GLOBAL_RULES));
  expect(f.last('central').messages[0]!.content).toContain('WORKER_INSTRUCTIONS');

  await store.update((draft) => {
    draft.agents['conventions-warden']!.prompt = 'EDITED_RULES';
    draft.agents.worker!.prompt = 'EDITED_WORKER';
    draft.sources['global-conventions']!.uri = 'EDITED_KNOWLEDGE';
  });
  await store.settled();

  await thread.dispatch('worker', 'Second turn');
  const pre = f.last('pre');
  expect(pre.messages[0]!.content).toBe(chartered('EDITED_RULES'));
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

test('a project extension edit and a guard-trigger edit reach a running project thread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-live-project-'));
  dirs.push(dir);
  const store = new ConfigStore(dir);
  const c = config();
  c.agents['conventions-warden']!.guardTriggers = [];
  c.projects.P!.agents = {
    'conventions-warden': { extends: 'conventions-warden', prompt: 'Use Bun' },
  };
  await store.save(c);
  const f = setup(structuredClone(store.config));
  managers.push(f.manager);
  store.onChange((next) => f.factory.reconfigure(next));
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  const lib = f.manager.get(thread.id)!.domainLibrarians.get('conventions')!;
  expect(lib.shouldGuard('Write')).toBe(false);

  await store.update((draft) => {
    draft.projects.P!.agents!['conventions-warden'] = {
      extends: 'conventions-warden',
      prompt: 'Use Bun 1.4',
      guardTriggers: { append: ['Write'] },
    };
  });
  await store.settled();
  await thread.dispatch('worker', 'Next turn');
  expect(f.last('pre').messages[0]!.content).toContain('Use Bun 1.4');
  expect(lib.shouldGuard('Write')).toBe(true);
  const guard = await lib.guard({ tool: 'Write', input: { file_path: 'a.ts' } });
  expect(guard.request).toMatchObject({ status: 'supplied' });
  // Guard and advise share the instructions; the guard phase appends its own protocol.
  const guarded = f.last('pre');
  expect(guarded.messages[0]!.content).toBe(
    chartered(
      '## Global instructions (conventions-warden)\n\nGLOBAL_RULES: merge yourself once green.\n\n## Project instructions (P)\n\nUse Bun 1.4',
    ),
  );
  expect(guarded.messages[1]!.content).toContain(
    '## Response protocol (guard phase, trigger: agent-action)',
  );
});

test('an edit that cannot be built changes nothing on live threads', async () => {
  const c = config();
  const f = setup(structuredClone(c));
  managers.push(f.manager);
  const thread = f.factory.create('main');
  const next = structuredClone(c);
  next.agents.worker!.provider = 'unconstructed';
  next.agents['conventions-warden']!.prompt = 'NEVER_APPLIED';
  await expect(f.factory.reconfigure(next)).rejects.toThrow('No provider registered');
  await thread.dispatch('worker', 'Turn');
  expect(f.last('pre').messages[0]!.content).toBe(chartered(GLOBAL_RULES));
  // The factory keeps the configuration it can build.
  expect(() => f.factory.create('later')).not.toThrow();
});

test('a hand edit to settings.json is versioned as a file edit and applied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-file-edit-'));
  dirs.push(dir);
  const store = new ConfigStore(dir);
  await store.save(config());
  const seen: string[] = [];
  store.onChange((next) => {
    seen.push(next.agents['conventions-warden']!.prompt);
  });
  const edited = config();
  edited.agents['conventions-warden']!.prompt = 'HAND_EDITED';
  await Bun.write(join(dir, 'settings.json'), JSON.stringify(edited));
  await store.load();
  await store.settled();
  expect(seen).toEqual(['HAND_EDITED']);
  const entry = (await store.history('agent:conventions-warden'))[0]!.entries.at(-1)!;
  expect(entry.author).toBe('file');
});

test('ambiguous or unbuildable project agents are refused before they are saved', () => {
  const c = config();
  c.agents['docs-warden'] = { ...warden(), id: 'docs-warden', domain: 'docs' };
  // An extension may not take another global agent's id.
  c.projects.P!.agents = { 'docs-warden': { extends: 'conventions-warden', prompt: 'x' } };
  expect(() => validateConfig(c)).toThrow('names another agent');
  // Nor the id another entry extends.
  c.projects.P!.agents = {
    'p-docs': { extends: 'conventions-warden', prompt: 'x' },
    q: { extends: 'p-docs' },
  };
  expect(() => validateConfig(c)).toThrow('names another agent');
  // Identity fields belong to the parent.
  c.projects.P!.agents = {
    'conventions-warden': {
      extends: 'conventions-warden',
      domain: 'docs',
    } as unknown as AgentSettingsConfig,
  };
  expect(() => validateConfig(c)).toThrow('cannot be set on an extension');
  // What thread construction would refuse is refused at save.
  c.projects.P!.agents = {
    'conventions-warden': { extends: 'conventions-warden', override: ['instructions'], prompt: '' },
  };
  expect(() => validateConfig(c)).toThrow('requires explicit instructions');
  c.projects.P!.agents = {
    'conventions-warden': { extends: 'conventions-warden', domainKnowledge: ['missing-source'] },
  };
  expect(() => validateConfig(c)).toThrow('unknown sources');
  // A Warden's instructions never restate a response format.
  c.projects.P!.agents = {};
  c.agents['conventions-warden']!.prompt = 'Rules.\nRespond with JSON: {"mode": "advise"}';
  expect(() => validateConfig(c)).toThrow('must not state a response format');
});
