import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextLayer, ContextStack, type LLMProvider, Thread } from '@inixiative/foundry-core';
import { resolveThreadDomains } from '../src/agents/configured-experts';
import { buildAgents, buildLayers, ThreadFactory } from '../src/agents/thread-factory';
import { DEFAULT_THREAD_DOMAINS, ThreadRuntimeManager } from '../src/agents/thread-runtime';
import { type FoundryConfig, starterConfig } from '../src/viewer/config';
import { resolveProjectView } from '../src/viewer/config-resolve';
import { writeRegions } from './helpers/regions';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Settings with project P, whose repository holds the region `docs`: enabled (its Warden runs in P's
 * threads), present but not enabled, or no project at all.
 */
function configuration(chorus: 'enabled' | 'off' | 'absent' = 'enabled') {
  const c = starterConfig('controlled', 'expert-model');
  c.agents = {};
  c.layers = Object.fromEntries(
    ['docs', 'conventions'].map((id) => [
      id,
      {
        id,
        prompt: 'PRIVATE_LAYER_CONTENT_'.repeat(500),
        sourceIds: [],
        staleness: 0,
        enabled: true,
      },
    ]),
  );
  if (chorus !== 'absent') {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'foundry-diagnostics-')));
    dirs.push(project);
    writeRegions(project, [{ id: 'docs', knowledge: 'PRIVATE_SOURCE' }], {
      enabled: chorus === 'enabled',
    });
    c.projects.P = { id: 'P', path: project };
  }
  return c;
}

/** A thread in project P (its chorus), or outside any project. */
const inProject = (c: FoundryConfig) => (c.projects.P ? { projectId: 'P' } : {});

function setup(config: FoundryConfig) {
  let calls = 0,
    loads = 0;
  const warnings: string[] = [];
  const provider = (id: string): LLMProvider => ({
    id,
    complete: async () => {
      calls++;
      throw Error('Inspection cannot admit a model');
    },
  });
  const llm = provider('controlled'),
    phase = provider('phase'),
    providers = new Map([
      [llm.id, llm],
      [phase.id, phase],
    ]);
  const layers = {
    sourceResolver: () => ({
      id: 'private',
      load: async () => {
        loads++;
        return 'PRIVATE_SOURCE';
      },
    }),
  };
  const stack = new ContextStack(buildLayers(config, layers));
  const manager = new ThreadRuntimeManager({
    config,
    llm,
    providers,
    warn: (message) => warnings.push(message),
    log() {},
  });
  const agents = { provider: llm, providers };
  const factory = new ThreadFactory({
    stack,
    agents: buildAgents(config, stack, agents),
    runtime: manager,
    configuration: { config, layers, agents },
  });
  return {
    factory,
    manager,
    warnings,
    llm,
    providers,
    get calls() {
      return calls;
    },
    get loads() {
      return loads;
    },
  };
}

for (const mode of ['enabled', 'off', 'absent'] as const) {
  test(`a chorus ${mode} attaches without diagnostics, model calls or source loads`, () => {
    const c = configuration(mode);
    const f = setup(c);
    try {
      const t = f.factory.create(mode, inProject(c)),
        runtime = f.manager.get(t.id)!;
      expect(runtime.domainLibrarians.has('docs')).toBe(mode === 'enabled');
      expect(f.warnings).toHaveLength(0);
      expect(f.calls).toBe(0);
      expect(f.loads).toBe(0);
    } finally {
      f.manager.disposeAll();
    }
  });
}

test('explicit review override is reported while requested phase settings and pre profile remain intact', () => {
  const c = configuration();
  c.learning = {
    review: { provider: 'phase', model: 'review-model', thinking: 'medium', maxTokens: 1700 },
  };
  const original = JSON.stringify(c),
    f = setup(c);
  try {
    const t = f.factory.create('override', inProject(c)),
      lib = f.manager.get(t.id)!.domainLibrarians.get('docs')!;
    expect(lib.reviewProviderId).toBe('phase');
    expect(lib.reviewOptions).toMatchObject({
      model: 'review-model',
      thinking: 'medium',
      maxTokens: 1700,
      tools: false,
      maxTurns: 1,
      timeout: 0,
    });
    const view = resolveProjectView(c, 'P')!.config;
    const resolved = resolveThreadDomains(
      view,
      new Map(buildLayers(view, { sourceResolver: () => null }).map((l) => [l.id, l])),
      { policy: DEFAULT_THREAD_DOMAINS, programmatic: [], llm: f.llm, providers: f.providers },
    ).find((d) => d.domain === 'docs')!;
    expect(resolved.adviseOpts).toMatchObject({ model: 'expert-model', tools: false, maxTurns: 1 });
    expect(resolved.adviseOpts!.thinking).toBeUndefined();
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain('expert-review-profile-override');
    expect(f.warnings[0]).toContain('domain="docs" agent="docs"');
    expect(f.warnings[0]).toContain('learning.review');
    expect(f.warnings[0]).toContain('changed=provider,model,thinking,maxTokens');
    expect(f.warnings[0]).toContain('requested');
    expect(f.warnings[0]).not.toContain('PRIVATE_');
    expect(f.manager.attach(t)).toBe(f.manager.get(t.id)!);
    expect(f.warnings).toHaveLength(1);
    expect(JSON.stringify(c)).toBe(original);
    expect(f.calls).toBe(0);
    expect(f.loads).toBe(0);
  } finally {
    f.manager.disposeAll();
  }
});

test('an explicit review profile equal to the expert profile does not claim an override', () => {
  const c = configuration();
  c.learning = { review: { provider: 'controlled', model: 'expert-model', maxTokens: 1600 } };
  const f = setup(c);
  try {
    f.factory.create('same-profile', inProject(c));
    expect(f.warnings).toHaveLength(0);
    expect(f.calls).toBe(0);
  } finally {
    f.manager.disposeAll();
  }
});

test('a later generated-layer conflict does not publish a successful resolution diagnostic', () => {
  const c = configuration('absent'),
    f = setup(c);
  const manager = new ThreadRuntimeManager({
    config: c,
    llm: f.llm,
    domains: [{ domain: 'conventions', layerId: 'conventions', guardTriggers: [] }],
    warn: (message) => f.warnings.push(message),
  });
  const t = new Thread(
    'collision',
    new ContextStack([
      new ContextLayer({ id: 'docs' }),
      new ContextLayer({ id: 'conventions' }),
      new ContextLayer({ id: 'thread-knowledge:conventions' }),
    ]),
  );
  try {
    expect(() => manager.attach(t)).toThrow('Generated expert layer already exists');
    expect(f.warnings).toHaveLength(0);
    expect(manager.runtimes.size).toBe(0);
    expect(f.calls).toBe(0);
  } finally {
    t.dispose();
    manager.disposeAll();
    f.manager.disposeAll();
  }
});
