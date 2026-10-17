import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CompletionOpts,
  ContextLayer,
  ContextStack,
  EventStream,
  type LLMMessage,
  type LLMProvider,
  Thread,
} from '@inixiative/foundry-core';
import { REGION_GUARD_TRIGGERS } from '../src/agents/region-roster';
import {
  buildAgents,
  buildLayers,
  type SourceResolver,
  ThreadFactory,
} from '../src/agents/thread-factory';
import { ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { KnowledgePersistence } from '../src/persistence/knowledge-persistence';
import { LocalSessionStore } from '../src/persistence/local-session-store';
import { SessionBackedProvider } from '../src/providers/session-backed';
import { ConfigStore, type FoundryConfig, starterConfig } from '../src/viewer/config';
import { resolveProjectView } from '../src/viewer/config-resolve';
import { type TestRegion, writeRegions } from './helpers/regions';

const COMPAT = { id: 'compatibility', knowledge: 'DOMAIN_COMPAT: old readers still work' };
const TESTING = { id: 'testing', knowledge: 'DOMAIN_TEST: require a legacy reader regression' };

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
/** A project directory whose repository enables a chorus of `regions`. */
async function regionProject(regions: TestRegion[], options: { enabled?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'e1-region-project-'));
  dirs.push(dir);
  writeRegions(dir, regions, options);
  return dir;
}

/** Settings: the worker, and project P (and Q) at `paths`. Wardens come only from their regions. */
function config(paths: { P?: string; Q?: string } = {}) {
  const c = starterConfig('central', 'central-model');
  c.agents = {
    worker: {
      id: 'worker',
      kind: 'executor',
      prompt: 'Implement the requested change',
      provider: 'central',
      model: 'central-model',
      visibleLayers: [],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
  };
  c.layers = {};
  c.sources = {};
  for (const [id, path] of Object.entries(paths)) if (path) c.projects[id] = { id, path };
  return c;
}
interface Call {
  phase: 'central' | 'pre' | 'post' | 'route';
  provider: string;
  messages: LLMMessage[];
  opts: CompletionOpts;
}
function setup(
  c: FoundryConfig,
  store?: LocalSessionStore,
  review?: (call: Call) => Promise<string> | string,
  extra?: LLMProvider,
) {
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
      const call = { phase, provider: id, messages: structuredClone(messages), opts: { ...opts } };
      calls.push(call);
      const domain = opts.threadId?.split(':domain:').at(-1) ?? 'compatibility';
      return {
        model: opts.model ?? 'controlled',
        content:
          phase === 'central'
            ? 'COMPLETED: additive migration and regression verified'
            : phase === 'route'
              ? JSON.stringify({
                  domains: ['compatibility', 'testing'],
                  layers: ['compatibility-reference', 'testing-reference'],
                  confidence: 1,
                })
              : phase === 'pre'
                ? JSON.stringify({ layers: [`${domain}-reference`], snippets: [], confidence: 1 })
                : review
                  ? await review(call)
                  : JSON.stringify({
                      knowledge: `PRIVATE_${domain}: ${messages.some((m) => m.content.includes('additive migration')) ? 'additive migration verified' : 'observed completed work'}`,
                      facts: [],
                      reason: `OWNED_${domain}_REASON`,
                    }),
      };
    },
  });
  const central = provider('central'),
    flow = provider('flow'),
    experts = provider('expert'),
    phase = provider('phase');
  const providers = new Map(
    [central, flow, experts, phase, ...(extra ? [extra] : [])].map((p) => [p.id, p]),
  );
  // A region's knowledge is its knowledge.md; inline sources are their text.
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
  const persistence = store && new KnowledgePersistence(manager, store, new EventStream(), []);
  const deps = { provider: central, providers };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(c, stack, deps),
    runtime: manager,
    configuration: { config: c, layers: { sourceResolver }, agents: deps },
  });
  return {
    factory,
    manager,
    stack,
    calls,
    persistence,
    async close() {
      for (const runtime of manager.runtimes.values()) await runtime.learningSettled();
      manager.disposeAll();
    },
  };
}

test('region Wardens learn through production factory/journal, remain separate and survive a fresh configuration/factory reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e1-saved-experts-'));
  let f: ReturnType<typeof setup> | undefined;
  let journal: LocalSessionStore | undefined;
  try {
    writeRegions(dir, [COMPAT, TESTING]);
    const c = config({ P: dir, Q: dir });
    const settings = new ConfigStore(dir);
    await settings.save(c);
    const loaded = await new ConfigStore(dir).load();
    const savedBytes = await readFile(join(dir, 'settings.json'), 'utf8');
    journal = new LocalSessionStore(join(dir, 'sessions.sqlite'));
    f = setup(loaded, journal);
    const a = f.factory.create('A', { projectId: 'P' }),
      runtime = f.manager.get('A')!;
    expect([...runtime.domainLibrarians.keys()]).toEqual(['compatibility', 'testing']);
    // A Warden's composed slots are private: never on the thread's stack, never sent centrally.
    expect(a.stack.layers.some((layer) => layer.id.startsWith('role:'))).toBe(false);
    const first = await a.dispatch('worker', 'Implement the migration', undefined, {
      messageId: 'A1',
    });
    const frozen = JSON.stringify(first.meta?.injection);
    await runtime.learningSettled();
    for (const domain of ['compatibility', 'testing']) {
      const lib = runtime.domainLibrarians.get(domain)!;
      expect(lib.threadKnowledge.revision).toBe(1);
      expect(lib.threadKnowledge.content).toContain(`PRIVATE_${domain}`);
      expect(journal.knowledge('A')!.domains[domain].content).toBe(lib.threadKnowledge.content);
      const post = f.calls.find(
        (call) => call.phase === 'post' && call.opts.threadId?.endsWith(`:domain:${domain}`),
      )!;
      // A region Warden runs on the default profile.
      expect(post.provider).toBe('central');
      expect(post.opts).toMatchObject({
        model: 'central-model',
        tools: false,
        maxTurns: 1,
        timeout: 0,
      });
      expect(post.messages[0].content).toContain(`(\`${domain}\`)`);
      expect(post.messages[1].content).toContain(
        domain === 'compatibility' ? 'DOMAIN_COMPAT' : 'DOMAIN_TEST',
      );
      expect(post.messages[1].content).not.toContain(
        domain === 'compatibility' ? 'DOMAIN_TEST' : 'DOMAIN_COMPAT',
      );
    }
    await a.dispatch('worker', 'Continue', undefined, { messageId: 'A2' });
    await runtime.learningSettled();
    const central = f.calls.filter((call) => call.phase === 'central').at(-1)!;
    expect(JSON.stringify(central.messages)).not.toContain('DOMAIN_COMPAT');
    expect(JSON.stringify(central.messages)).toContain('PRIVATE_compatibility');
    expect(JSON.stringify(central.messages)).toContain('PRIVATE_testing');
    expect(JSON.stringify(central.messages)).not.toContain('OWNED_compatibility_REASON');
    expect(JSON.stringify(first.meta?.injection)).toBe(frozen);
    const advice = f.calls
      .filter(
        (call) => call.phase === 'pre' && call.opts.threadId?.endsWith(':domain:compatibility'),
      )
      .at(-1)!;
    expect(advice.opts).toMatchObject({ model: 'central-model', tools: false, maxTurns: 1 });
    expect(JSON.stringify(advice.messages)).toContain('PRIVATE_compatibility');
    expect(JSON.stringify(advice.messages)).not.toContain('PRIVATE_testing');
    const b = f.factory.create('B', { projectId: 'Q' });
    for (const lib of f.manager.get(b.id)!.domainLibrarians.values())
      expect(lib.threadKnowledge.content).toBe('');
    await b.dispatch('worker', 'Unrelated work');
    await f.manager.get(b.id)!.learningSettled();
    const unrelatedInput = f.calls.find(
      (call) => call.phase === 'central' && call.opts.threadId === 'B',
    )!;
    expect(JSON.stringify(unrelatedInput.messages)).not.toContain('PRIVATE_compatibility');
    expect(JSON.stringify(unrelatedInput.messages)).not.toContain('PRIVATE_testing');
    expect(JSON.stringify(first.meta?.injection)).toBe(frozen);
    expect(f.stack.getLayer('thread-knowledge:compatibility')).toBeUndefined();
    const snapshot = journal.knowledge('A')!;
    const callCount = f.calls.length;
    await f.close();
    journal.close();
    journal = new LocalSessionStore(join(dir, 'sessions.sqlite'));
    f = setup(await new ConfigStore(dir).load(), journal);
    const restored = f.factory.create('A', { projectId: 'P' });
    expect(f.calls).toHaveLength(0);
    expect(callCount).toBeGreaterThan(0);
    for (const d of ['compatibility', 'testing'])
      expect(f.manager.get('A')!.knowledgeSnapshot().domains[d]).toEqual(snapshot.domains[d]);
    expect(restored.stack.getLayer('thread-knowledge:compatibility')!.content).toContain(
      'PRIVATE_compatibility',
    );
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(savedBytes);
  } finally {
    await f?.close();
    journal?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("each project's chorus is its own regions; learning.review applies to them; a thread outside a project has none", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e1-project-resolution-'));
  dirs.push(dir);
  const p = await regionProject([{ id: 'compatibility', knowledge: 'PROJECT_COMPAT_KNOWLEDGE' }]);
  const q = await regionProject([{ id: 'testing', knowledge: 'ONLY_Q_TEST_KNOWLEDGE' }]);
  const c = config({ P: p, Q: q });
  c.learning = {
    review: { provider: 'phase', model: 'explicit-review', maxTokens: 1700, thinking: 'high' },
  };
  let f: ReturnType<typeof setup> | undefined;
  try {
    const store = new ConfigStore(dir);
    await store.save(c);
    f = setup(await new ConfigStore(dir).load());
    const pThread = f.factory.create('P-thread', { projectId: 'P' }),
      qThread = f.factory.create('Q-thread', { projectId: 'Q' }),
      g = f.factory.create('global-thread');
    expect([...f.manager.get(pThread.id)!.domainLibrarians.keys()]).toEqual(['compatibility']);
    expect([...f.manager.get(qThread.id)!.domainLibrarians.keys()]).toEqual(['testing']);
    expect(f.manager.get(g.id)!.domainLibrarians.size).toBe(0);
    for (const thread of [pThread, qThread, g]) {
      await thread.dispatch('worker', 'Work');
      await f.manager.get(thread.id)!.learningSettled();
    }
    const pre = f.calls.find(
      (call) => call.phase === 'pre' && call.opts.threadId?.startsWith(pThread.id),
    )!;
    expect(JSON.stringify(pre.messages)).toContain('PROJECT_COMPAT_KNOWLEDGE');
    expect(JSON.stringify(pre.messages)).not.toContain('ONLY_Q_TEST_KNOWLEDGE');
    const post = f.calls.find(
      (call) => call.phase === 'post' && call.opts.threadId?.startsWith(pThread.id),
    )!;
    expect(post.provider).toBe('phase');
    expect(post.opts).toMatchObject({
      model: 'explicit-review',
      thinking: 'high',
      maxTokens: 1700,
      tools: false,
    });
    expect(
      f.calls.some(
        (call) =>
          (call.phase === 'pre' || call.phase === 'post') && call.opts.threadId?.startsWith(g.id),
      ),
    ).toBe(false);
    expect(resolveProjectView(c, 'P')!.config.learning).toEqual(c.learning);
  } finally {
    await f?.close();
  }
});

test('configured review pending does not block Continue or create another same-domain review', async () => {
  let release!: (value: string) => void;
  const held = new Promise<string>((resolve) => {
    release = resolve;
  });
  const f = setup(config({ P: await regionProject([COMPAT]) }), undefined, () => held);
  try {
    const t = f.factory.create('pending', { projectId: 'P' }),
      runtime = f.manager.get(t.id)!;
    await t.dispatch('worker', 'Work');
    const next = await Promise.race([
      t.dispatch('worker', 'Continue'),
      Bun.sleep(200).then(() => {
        throw Error('Central waited for expert review');
      }),
    ]);
    expect((next.meta?.delivery as { learningBarrier?: unknown })?.learningBarrier).toMatchObject({
      outcome: 'pending',
      waitedMs: 0,
    });
    expect(f.calls.filter((c) => c.phase === 'post')).toHaveLength(1);
    expect(JSON.stringify(next.meta?.injection)).not.toContain('PENDING_FACT');
    release(JSON.stringify({ knowledge: 'PENDING_FACT', facts: [] }));
    await runtime.learningSettled();
    await t.dispatch('worker', 'Continue');
    await runtime.learningSettled();
    expect(JSON.stringify(f.calls.filter((c) => c.phase === 'central').at(-1)?.messages)).toContain(
      'PENDING_FACT',
    );
    expect(JSON.stringify(next.meta?.injection)).not.toContain('PENDING_FACT');
  } finally {
    release('NO_COMMENT');
    await f.close();
  }
});

for (const state of ['chorus-off', 'layer-named-like-a-domain'] as const)
  test(`${state} cannot resurrect a Warden`, async () => {
    const c = config({
      P: await regionProject([{ id: 'security' }], { enabled: state !== 'chorus-off' }),
    });
    if (state === 'layer-named-like-a-domain') {
      // A layer with a domain's name and metadata is passive: only a project's regions make Wardens.
      c.projects.P!.path = await regionProject([]);
      c.sources.notes = { id: 'notes', label: 'N', type: 'inline', uri: 'x', enabled: true };
      c.layers.security = {
        id: 'security',
        domain: 'security',
        prompt: 'Security',
        sourceIds: ['notes'],
        staleness: 0,
        enabled: true,
      };
    }
    const f = setup(c);
    try {
      const t = f.factory.create(state, { projectId: 'P' });
      expect(f.manager.get(t.id)!.domainLibrarians.size).toBe(0);
      expect(f.calls).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test('missing provider and unsupported actual native profiles are refused before native construction', async () => {
  const project = await regionProject([COMPAT]);
  for (const mode of ['missing', 'codex'] as const) {
    const c = config({ P: project });
    let creates = 0;
    const id = 'codex';
    const native = new SessionBackedProvider({
      id,
      defaultModel: 'explicit-model',
      adapter: {
        runtime: id,
        createSession: async () => {
          creates++;
          throw Error('No native construction permitted');
        },
        getExternalSessionId: async () => null,
        clearSession: async () => {},
      },
    });
    // A region Warden runs on the default profile: an absent or unsupported one is refused.
    c.defaults.provider = mode === 'missing' ? 'absent' : id;
    const f = setup(c, undefined, undefined, native);
    try {
      expect(() => f.factory.create('unsupported', { projectId: 'P' })).toThrow();
      expect(creates).toBe(0);
      expect(f.calls).toHaveLength(0);
      expect(f.manager.runtimes.size).toBe(0);
    } finally {
      await f.close();
    }
  }
});

const CODE_PROMPT = 'CODE_WARDEN: pick the docs this message needs.';
test('a code-registered Warden reads the stack layer it names, with its own prompt', () => {
  const c = config();
  const layer = new ContextLayer({ id: 'docs' });
  layer.set('CODE_DOCS');
  const manager = new ThreadRuntimeManager({
    config: c,
    llm: {
      id: 'flow',
      complete: async () => {
        throw Error('No inspection model call');
      },
    },
    domains: [{ domain: 'docs', layerId: 'docs', advisePrompt: CODE_PROMPT, guardTriggers: [] }],
    log() {},
    warn() {},
  });
  const thread = new Thread('code', new ContextStack([layer]));
  try {
    const lib = manager.attach(thread).domainLibrarians.get('docs')!;
    expect(lib.advisePrompt).toBe(CODE_PROMPT);
    expect(lib.cache).toBe(layer);
  } finally {
    thread.dispose();
    manager.disposeAll();
  }
});

test('a region Warden is asked on every write or exec tool call, under its generated region prompt', async () => {
  const f = setup(config({ P: await regionProject([{ id: 'security' }]) }));
  try {
    const thread = f.factory.create('security-guard', { projectId: 'P' }),
      lib = f.manager.get(thread.id)!.domainLibrarians.get('security')!;
    for (const tool of REGION_GUARD_TRIGGERS) expect(lib.shouldGuard(tool)).toBe(true);
    expect(lib.shouldGuard('Read')).toBe(false);
    expect(lib.advisePrompt).toContain('You are a region Warden.');
    expect(lib.advisePrompt).toContain('(`security`)');
    expect(lib.reviewPrompt).toBe(lib.advisePrompt);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('metadata-only/generated layers and a conflicting generated ID never silently become legacy expert state', async () => {
  for (const generated of [false, true]) {
    const c = config();
    const layer = new ContextLayer({
      id: 'security',
      ...(generated
        ? { segment: 'thread-knowledge' as const }
        : { definition: { id: 'security', domain: 'security' } }),
    });
    const manager = new ThreadRuntimeManager({
      config: c,
      llm: {
        id: 'flow',
        complete: async () => {
          throw Error('No call allowed');
        },
      },
      log() {},
      warn() {},
    });
    const t = new Thread('passive', new ContextStack([layer]));
    try {
      expect(manager.attach(t).domainLibrarians.size).toBe(0);
    } finally {
      t.dispose();
      manager.disposeAll();
    }
  }
  const c = config({ P: await regionProject([COMPAT]) });
  const stack = new ContextStack([
    new ContextLayer({ id: 'compatibility-reference' }),
    new ContextLayer({ id: 'thread-knowledge:compatibility' }),
  ]);
  const t = new Thread('collision', stack, { projectId: 'P' });
  const manager = new ThreadRuntimeManager({
    config: c,
    llm: {
      id: 'central',
      complete: async () => {
        throw Error('No call allowed');
      },
    },
  });
  try {
    expect(() => manager.attach(t)).toThrow('Generated expert layer already exists');
    expect(manager.runtimes.size).toBe(0);
    expect(stack.layers).toHaveLength(2);
  } finally {
    t.dispose();
    manager.disposeAll();
  }
});
