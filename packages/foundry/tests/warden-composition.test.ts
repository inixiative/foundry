import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CompletionOpts,
  ContextStack,
  type LLMMessage,
  type LLMProvider,
} from '@inixiative/foundry-core';
import { configuredExperts } from '../src/agents/configured-experts';
import { oneCall } from '../src/agents/domain-librarian';
import { regionInstructions } from '../src/agents/region-roster';
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
import { writeRegions } from './helpers/regions';

const dirs: string[] = [];
const tempDir = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `foundry-${name}-`)));
  dirs.push(dir);
  return dir;
};

const REGION = {
  id: 'conventions',
  title: 'Conventions',
  routing: 'Is this about how this repo works?',
  knowledge: 'GLOBAL_KNOWLEDGE: look for what exists first.',
};
/** The region Warden's settings prompt, as `regionWardens` generates it. */
const REGION_RULES = regionInstructions(REGION);

/** A project whose repository enables a one-region chorus. */
function regionProject(): string {
  const project = tempDir('composition-project');
  writeRegions(project, [REGION]);
  return project;
}

function config(project = regionProject()): FoundryConfig {
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
  };
  c.layers = {};
  c.composition = { preset: 'none' };
  c.sources = {};
  c.projects.P = { id: 'P', path: project };
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
    flow = provider('flow');
  const providers = new Map([central, flow].map((p) => [p.id, p]));
  // Inline sources are their text; a region's markdown source is its knowledge.md.
  const sourceResolver: SourceResolver = (id, cfg) => {
    const source = cfg.sources[id];
    if (!source) return null;
    return {
      id,
      load: async () => (source.type === 'markdown' ? Bun.file(source.uri).text() : source.uri),
    };
  };
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

const managers: ThreadRuntimeManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const runtime of manager.runtimes.values()) await runtime.learningSettled();
    manager.disposeAll();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a region Warden's call: the charter over its region instructions, its knowledge the region's text", async () => {
  const c = config();
  validateConfig(c);
  const view = resolveProjectView(c, 'P')!;
  expect(view.config.agents.conventions).toMatchObject({
    kind: 'domain-librarian',
    flowRole: 'domain-advising',
    domain: 'conventions',
    prompt: REGION_RULES,
  });
  expect(view.agents.find((a) => a.id === 'conventions')).toMatchObject({
    scope: 'project-generated',
  });

  const f = setup(c);
  managers.push(f.manager);
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  await thread.dispatch('worker', 'Add a script');
  const pre = f.last('pre');
  expect(pre.messages[0]!.content).toBe(chartered(REGION_RULES));
  expect(pre.messages[1]!.content).toContain('GLOBAL_KNOWLEDGE: look for what exists first.');
});

test('a thread without a project, or in a project whose chorus is off, has no Wardens', async () => {
  const off = tempDir('off-project');
  writeRegions(off, [REGION], { enabled: false });
  const c = config(off);
  validateConfig(c);
  expect(configuredExperts(c).experts).toEqual([]);
  expect(configuredExperts(resolveProjectView(c, 'P')!.config).experts).toEqual([]);
  const f = setup(c);
  managers.push(f.manager);
  for (const thread of [f.factory.create('main'), f.factory.create('p', { projectId: 'P' })]) {
    await thread.dispatch('worker', 'Turn');
    expect(f.manager.get(thread.id)!.domainLibrarians.size).toBe(0);
  }
  expect(f.calls.some((call) => call.phase === 'pre')).toBe(false);
});

test('settings declare no Wardens: a hand-named one is refused by name, with the fix', () => {
  const warden = {
    id: 'conventions-warden',
    kind: 'domain-librarian',
    flowRole: 'domain-advising',
    domain: 'conventions',
    prompt: 'RULES',
    tools: false,
    visibleLayers: [],
    peers: [],
    maxDepth: 1,
    enabled: true,
  } as AgentSettingsConfig;
  const global = config();
  global.agents['conventions-warden'] = warden;
  expect(() => validateConfig(global)).toThrow(
    'agents.conventions-warden is a hand-named Warden (domain-librarian): the hand-named Warden roster is retired',
  );
  const project = config();
  project.projects.P!.agents = { 'p-warden': { ...warden, id: 'p-warden' } };
  expect(() => validateConfig(project)).toThrow(
    'projects.P.agents.p-warden is a hand-named Warden',
  );
  const decider = config();
  decider.agents.old = { ...warden, id: 'old', kind: 'decider' } as unknown as AgentSettingsConfig;
  expect(() => validateConfig(decider)).toThrow('agents.old is a hand-named Warden (decider)');
  expect(() => validateConfig(decider)).toThrow('"chorus": { "enabled": true }');
});

test('project agents are standalone or extend a global agent; nothing in between', () => {
  const c = config();
  c.projects.P!.agents = { worker: { extends: 'missing' } };
  expect(() => validateConfig(c)).toThrow('is not a global agent');
  c.projects.P!.agents = { worker: { extends: 'worker', override: ['instructions'] } };
  expect(() => validateConfig(c)).toThrow('overrides instructions without a prompt');
  c.projects.P!.agents = { worker: { extends: 'worker', prompt: 'Use Bun' } };
  validateConfig(c);
  const view = resolveProjectView(c, 'P')!;
  expect(view.config.agents.worker!.prompt).toBe(
    '## Global instructions (worker)\n\nWORKER_INSTRUCTIONS\n\n## Project instructions (P)\n\nUse Bun',
  );
  expect(view.agents.find((a) => a.id === 'worker')!.fields.prompt).toMatchObject({
    origin: 'merged',
    strategy: 'extend',
  });
  c.projects.P!.agents = { 'p-worker': { extends: 'worker', prompt: 'Use Bun' } };
  const superseded = resolveProjectView(c, 'P')!.config;
  expect(superseded.agents.worker).toBeUndefined();
  expect(superseded.agents['p-worker']).toMatchObject({ id: 'p-worker', kind: 'executor' });
  // The region Warden stands beside the project's agents.
  expect(configuredExperts(superseded).experts.map((e) => e.agentId)).toEqual(['conventions']);
});

test('a settings edit reaches a running thread on its next turn, with a versioned before/after', async () => {
  const dir = tempDir('live-settings');
  const store = new ConfigStore(dir);
  await store.save(config());
  const f = setup(structuredClone(store.config));
  managers.push(f.manager);
  store.onChange((next) => f.factory.reconfigure(next));
  const thread = f.factory.create('p-thread', { projectId: 'P' });

  await thread.dispatch('worker', 'First turn');
  expect(f.last('pre').messages[0]!.content).toBe(chartered(REGION_RULES));
  expect(f.last('central').messages[0]!.content).toContain('WORKER_INSTRUCTIONS');

  await store.update((draft) => {
    draft.agents.worker!.prompt = 'EDITED_WORKER';
  });
  await store.settled();

  await thread.dispatch('worker', 'Second turn');
  expect(f.last('pre').messages[0]!.content).toBe(chartered(REGION_RULES));
  expect(f.last('central').messages[0]!.content).toContain('EDITED_WORKER');

  const [log] = await store.history('agent:worker');
  const edit = log!.entries.at(-1)!;
  expect(edit.author).toBe('user');
  expect(edit.snapshot.before).toMatchObject({ prompt: 'WORKER_INSTRUCTIONS' });
  expect(edit.snapshot.after).toMatchObject({ prompt: 'EDITED_WORKER' });
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
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  expect(thread.getAgent('cartographer')).toBeUndefined();
  expect(thread.getAgent('conventions')).toBeUndefined();
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

test('a region Warden guards a write under the pointer protocol', async () => {
  const c = config();
  const f = setup(c);
  managers.push(f.manager);
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  const lib = f.manager.get(thread.id)!.domainLibrarians.get('conventions')!;
  expect(lib.shouldGuard('Write')).toBe(true);
  await thread.dispatch('worker', 'Warm the Warden');
  const guard = await lib.guard(oneCall({ tool: 'Write', input: { file_path: 'a.ts' } }));
  expect(guard.request).toMatchObject({ status: 'supplied' });
  const guarded = f.last('pre');
  expect(guarded.messages[0]!.content).toBe(chartered(REGION_RULES));
  expect(guarded.messages[1]!.content).toContain(
    '## Response protocol (guard phase, trigger: agent-action)',
  );
  expect(guarded.messages[1]!.content).toContain('"severity": "advisory"');
});

test('an edit that cannot be built changes nothing on live threads', async () => {
  const c = config();
  const f = setup(structuredClone(c));
  managers.push(f.manager);
  const thread = f.factory.create('p-thread', { projectId: 'P' });
  const next = structuredClone(c);
  next.agents.worker!.provider = 'unconstructed';
  next.agents.worker!.prompt = 'NEVER_APPLIED';
  await expect(f.factory.reconfigure(next)).rejects.toThrow('No provider registered');
  await thread.dispatch('worker', 'Turn');
  expect(f.last('pre').messages[0]!.content).toBe(chartered(REGION_RULES));
  expect(f.last('central').messages[0]!.content).not.toContain('NEVER_APPLIED');
  expect(() => f.factory.create('later')).not.toThrow();
});

test('a hand edit to settings.json is versioned as a file edit and applied', async () => {
  const dir = tempDir('file-edit');
  const store = new ConfigStore(dir);
  await store.save(config());
  const seen: string[] = [];
  store.onChange((next) => {
    seen.push(next.agents.worker!.prompt);
  });
  const edited = structuredClone(store.config);
  edited.agents.worker!.prompt = 'HAND_EDITED';
  await Bun.write(join(dir, 'settings.json'), JSON.stringify(edited));
  await store.load();
  await store.settled();
  expect(seen).toEqual(['HAND_EDITED']);
  const entry = (await store.history('agent:worker'))[0]!.entries.at(-1)!;
  expect(entry.author).toBe('file');
});

test('ambiguous or unbuildable project agents are refused before they are saved', () => {
  const c = config();
  c.agents.reviewer = { ...c.agents.worker!, id: 'reviewer', prompt: 'REVIEW' };
  c.projects.P!.agents = { reviewer: { extends: 'worker', prompt: 'x' } };
  expect(() => validateConfig(c)).toThrow('names another agent');
  c.projects.P!.agents = {
    'p-worker': { extends: 'worker', prompt: 'x' },
    q: { extends: 'p-worker' },
  };
  expect(() => validateConfig(c)).toThrow('names another agent');
  c.projects.P!.agents = {
    worker: { extends: 'worker', kind: 'router' } as unknown as AgentSettingsConfig,
  };
  expect(() => validateConfig(c)).toThrow('cannot be set on an extension');
  c.projects.P!.agents = {};
  c.agents.cartographer = {
    id: 'cartographer',
    kind: 'cartographer',
    flowRole: 'context-routing',
    prompt: 'Rules.\nRespond with JSON: {"mode": "route"}',
    visibleLayers: [],
    peers: [],
    maxDepth: 1,
    enabled: true,
  };
  expect(() => validateConfig(c)).toThrow('must not state a response format');
});
