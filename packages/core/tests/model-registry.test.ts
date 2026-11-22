import { describe, expect, test } from 'bun:test';
import {
  DECISION_MODEL,
  DECISION_PROVIDER,
  type FoundryProviderInfo,
  MODEL_CAPABILITIES,
  MODEL_REGISTRY,
  MODEL_REGISTRY_UPDATED_AT,
  MODEL_VENDORS,
  type ModelCapability,
  modelCapabilities,
  modelHasCapability,
  modelOptionsByCapability,
  modelSpeeds,
  providersWithCapability,
  readModelRetirement,
  registryModel,
  resolveDecisionModel,
  resolveModelAliasToModelId,
  SUBSCRIPTION_WORKER_MODELS,
  vendorOfProvider,
} from '../src/index';

describe('the registry is reachable from core alone', () => {
  test("core's public entry exports the vocabulary, the table and the lookups", () => {
    // The point of the move: a core-only consumer (Oracle) can answer "which
    // model suits this experiment" without importing Foundry's adapters.
    expect(MODEL_CAPABILITIES).toContain('judgment');
    expect(Object.keys(MODEL_REGISTRY).length).toBeGreaterThan(10);
    expect(registryModel(DECISION_PROVIDER, DECISION_MODEL)).toBeDefined();
    expect(modelHasCapability(DECISION_PROVIDER, DECISION_MODEL, 'judgment')).toBe(true);
    expect(modelCapabilities('no-such-provider', 'no-such-model')).toEqual([]);
    expect(providersWithCapability('execution').map((p) => p.id)).not.toContain('typesafe');
  });

  test('core carries no dependency that an adapter would drag in', async () => {
    const source = await Bun.file(new URL('../src/model-registry.ts', import.meta.url)).text();
    expect(source).not.toMatch(/^\s*import\s/m);
    const { dependencies } = await Bun.file(new URL('../package.json', import.meta.url)).json();
    expect(Object.keys(dependencies).sort()).toEqual(['@inixiative/secret-scratch', 'uuidv7']);
  });

  test('resolveDecisionModel falls back to the registry defaults', () => {
    expect(resolveDecisionModel({ defaults: {} })).toEqual({
      provider: DECISION_PROVIDER,
      model: DECISION_MODEL,
    });
    expect(
      resolveDecisionModel({
        defaults: { decisionProvider: 'deepseek', decisionModel: 'deepseek-flash' },
      }),
    ).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    // The subscription decision profile is not a registered provider: it belongs
    // to the native path, so the API-token resolver hands back its own defaults.
    expect(
      resolveDecisionModel({
        defaults: { decisionProvider: 'subscription-decisions', decisionModel: 'gpt-6-luna' },
      }),
    ).toEqual({ provider: DECISION_PROVIDER, model: DECISION_MODEL });
  });

  test('every model still declares a capability from the vocabulary', () => {
    const vocabulary = new Set<ModelCapability>(MODEL_CAPABILITIES);
    for (const provider of Object.values(MODEL_REGISTRY))
      for (const model of provider.models) {
        expect(model.capabilities).toContain('judgment');
        for (const capability of model.capabilities) expect(vocabulary.has(capability)).toBe(true);
      }
    expect(modelOptionsByCapability('judgment').length).toBe(
      Object.values(MODEL_REGISTRY).reduce((total, provider) => total + provider.models.length, 0),
    );
  });
});

describe("Meta's Muse Spark", () => {
  const meta = MODEL_REGISTRY.meta!;

  test('is registered as an OpenAI-compatible host, not a new adapter kind', () => {
    expect(meta.type).toBe('openai-compatible');
    expect(meta.apiRoot).toBe('https://api.meta.ai/v1');
    expect(meta.credential).toBe('api-key');
    expect(meta.envKey).toBe('MODEL_API_KEY');
  });

  test('registers the five text models in published order and nothing else', () => {
    expect(meta.models.map((model) => model.id)).toEqual([
      'muse-spark-1.3',
      'muse-spark-1.3-contributor',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
      'muse-spark-1.1',
    ]);
    // Not chat models: they do not answer /v1/chat/completions.
    for (const id of [
      'muse-image',
      'muse-image-1.0',
      'muse-voice-transcribe-1.0',
      'sam-3.1',
      'sam-3-1',
    ])
      expect(registryModel('meta', id)).toBeUndefined();
    // Llama is the retired line; no fabricated successor is served.
    for (const id of ['llama-5', 'llama5', 'muse-spark-1.0'])
      expect(registryModel('meta', id)).toBeUndefined();
  });

  test('records the 1M window and refuses to guess an undocumented output cap', () => {
    for (const model of meta.models) {
      expect(model.contextWindow).toBe(1_048_576);
      expect(model.maxOutputTokens).toBeUndefined();
    }
  });

  test('always reasons: effort cannot be switched off and output is capped with max_completion_tokens', () => {
    for (const model of meta.models) {
      expect(model.capabilities).toContain('reasoning');
      expect(model.reasoning!.param).toBe('reasoning_effort');
      expect(model.reasoning!.efforts).not.toContain('none');
      expect(model.reasoning!.efforts).toContain(model.reasoning!.fallback);
      expect(model.reasoning!.outputField).toBe('max_completion_tokens');
    }
  });
});

describe('the contributor tier is visible at the point of choice', () => {
  test('only the -contributor ids are flagged, and every flagged one says so in its label', () => {
    const flagged: string[] = [];
    for (const provider of Object.values(MODEL_REGISTRY))
      for (const model of provider.models) {
        if (!model.trainsOnInput) continue;
        flagged.push(`${provider.id}/${model.id}`);
        // A <select> renders nothing but the label, so the label must carry it.
        expect(model.label).toContain('trains on your data');
        expect(model.notes).toContain('$0.10/$0.20');
      }
    expect(flagged).toEqual(['meta/muse-spark-1.3-contributor', 'meta/muse-spark-1.2-contributor']);
    for (const id of ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1']) {
      expect(registryModel('meta', id)!.trainsOnInput).toBeUndefined();
      expect(registryModel('meta', id)!.label).not.toContain('trains on your data');
    }
  });

  test('it is a term of use, not a capability, so it never changes model selection', () => {
    expect(MODEL_CAPABILITIES).not.toContain('trains-on-input' as ModelCapability);
    const standard = registryModel('meta', 'muse-spark-1.3')!;
    const contributor = registryModel('meta', 'muse-spark-1.3-contributor')!;
    // Same model, same fitness for work; only the price and the terms differ.
    expect(contributor.capabilities).toEqual(standard.capabilities);
    expect(contributor.tier).toBe(standard.tier);
    expect(contributor.costTier).toBe('low');
    expect(standard.costTier).toBe('high');
  });
});

describe('aliases and retirement', () => {
  const WORKERS = Object.keys(SUBSCRIPTION_WORKER_MODELS);

  test('every model a subscription worker serves names its family', () => {
    for (const worker of WORKERS)
      for (const model of MODEL_REGISTRY[worker]!.models)
        expect({ worker, model: model.id, family: model.family }).toEqual({
          worker,
          model: model.id,
          family: expect.any(String),
        });
  });

  test('an alias points to a listed, unaliased model of its own family', () => {
    for (const provider of Object.values(MODEL_REGISTRY))
      for (const model of provider.models.filter((entry) => entry.aliasOf)) {
        const target = registryModel(provider.id, model.aliasOf!);
        expect(target?.aliasOf).toBeUndefined();
        expect(target?.family).toBe(model.family!);
      }
    expect(resolveModelAliasToModelId('claude-code', 'opus')).toBe('claude-opus-5-5');
    expect(resolveModelAliasToModelId('claude-code', 'sonnet')).toBe('claude-sonnet-5-5');
    expect(resolveModelAliasToModelId('claude-code', 'claude-fable-5-1')).toBe('claude-fable-5-1');
    expect(resolveModelAliasToModelId('codex', 'not-listed')).toBe('not-listed');
  });

  test("every retired model's successor chain ends on a served model of its family", () => {
    for (const provider of Object.values(MODEL_REGISTRY))
      for (const model of provider.models.filter((entry) => entry.retired)) {
        const retirement = readModelRetirement(provider.id, model.id);
        expect(retirement).toMatchObject({ retired: true });
        // A succession stays in its family, so a model can only retire once it names one.
        expect({ model: model.id, family: model.family }).toEqual({
          model: model.id,
          family: expect.any(String),
        });
        if (retirement.retired && model.retired!.successor)
          expect(retirement.reason).toBeUndefined();
      }
  });

  const fixture: Record<string, FoundryProviderInfo> = {
    worker: {
      id: 'worker',
      type: 'claude-code',
      label: 'Worker',
      description: '',
      credential: 'subscription',
      enabledByDefault: true,
      models: [
        ['opus-1', 'opus', { at: '2026-01-01', successor: 'opus-2' }],
        ['opus-2', 'opus', { at: '2026-06-01', successor: 'opus-3' }],
        ['opus-3', 'opus', undefined],
        ['sonnet-1', 'sonnet', { at: '2026-01-01' }],
        ['sonnet-2', 'sonnet', { at: '2026-01-01', successor: 'opus-3' }],
        ['loop-a', 'loop', { at: '2026-01-01', successor: 'loop-b' }],
        ['loop-b', 'loop', { at: '2026-01-01', successor: 'loop-a' }],
      ].map(([id, family, retired]) => ({
        id: id as string,
        label: id as string,
        family: family as string,
        tier: 'powerful' as const,
        runtimeKind: 'native-harness' as const,
        capabilities: ['judgment'] as ModelCapability[],
        ...(retired ? { retired: retired as { at: string; successor?: string } } : {}),
      })),
    },
  };

  test('a retired model moves along its chain to the newest served model', () => {
    expect(readModelRetirement('worker', 'opus-1', fixture)).toEqual({
      retired: true,
      at: '2026-01-01',
      successor: 'opus-3',
    });
    expect(readModelRetirement('worker', 'opus-3', fixture)).toEqual({ retired: false });
    expect(readModelRetirement('worker', 'unknown', fixture)).toEqual({ retired: false });
  });

  test('no successor, another family or a loop is retired with a reason and no successor', () => {
    for (const id of ['sonnet-1', 'sonnet-2', 'loop-a']) {
      const retirement = readModelRetirement('worker', id, fixture);
      expect(retirement).toMatchObject({ retired: true, reason: expect.any(String) });
      expect(retirement).not.toHaveProperty('successor');
    }
  });
});

describe('Google Gemini Developer API models', () => {
  test('registers Gemini 4 Argon, 3.6 Flash and 3.5 Flash Lite limits and reasoning controls', () => {
    expect(MODEL_REGISTRY_UPDATED_AT).toBe('2026-11-21');

    const argon = registryModel('gemini', 'gemini-4-argon');
    expect(argon).toMatchObject({
      id: 'gemini-4-argon',
      tier: 'powerful',
      costTier: 'high',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      runtimeKind: 'api',
      reasoning: {
        param: 'thinking_level',
        efforts: ['low', 'medium', 'high'],
        fallback: 'medium',
      },
    });
    expect(argon?.capabilities).toContain('execution');
    expect(argon?.capabilities).toContain('reasoning');

    const flash36 = registryModel('gemini', 'gemini-3.6-flash');
    expect(flash36).toMatchObject({
      id: 'gemini-3.6-flash',
      tier: 'standard',
      costTier: 'medium',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      runtimeKind: 'api',
      reasoning: {
        param: 'thinking_level',
        efforts: ['low', 'medium', 'high'],
        fallback: 'medium',
      },
    });
    expect(flash36?.capabilities).toContain('warden-advice');
    expect(flash36?.capabilities).toContain('reasoning');

    const lite35 = registryModel('gemini', 'gemini-3.5-flash-lite');
    expect(lite35).toMatchObject({
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
    });
  });
});

describe('Google ACP subscription harnesses (Antigravity and Gemini CLI)', () => {
  test('registers Antigravity (agy) with Gemini 4 Neon/Carbon/Argon/Hydrogen and 3.8 Flash', () => {
    const agy = MODEL_REGISTRY.agy!;
    expect(agy).toMatchObject({
      id: 'agy',
      lab: 'google',
      type: 'agy',
      label: 'Antigravity (Google AI)',
      credential: 'subscription',
      enabledByDefault: false,
    });
    expect(agy.envKey).toBeUndefined();
    expect(agy.models.map((m) => m.id)).toEqual([
      'gemini-4-neon',
      'gemini-4-carbon',
      'gemini-4-argon',
      'gemini-4-hydrogen',
      'gemini-3.8-flash',
    ]);
    for (const model of agy.models) {
      expect(model.runtimeKind).toBe('native-harness');
      expect(model.contextWindow).toBe(1_048_576);
      expect(model.maxOutputTokens).toBe(65_536);
      const hasXhigh = model.id === 'gemini-4-neon' || model.id === 'gemini-4-hydrogen';
      expect(model.reasoning).toEqual({
        param: 'thinking_level',
        efforts: hasXhigh ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'],
        fallback: hasXhigh ? 'high' : 'medium',
      });
    }
    expect(SUBSCRIPTION_WORKER_MODELS.agy).toBe('gemini-4-neon');
    expect(vendorOfProvider('agy')).toMatchObject({
      vendor: { id: 'google', lab: 'google' },
      mode: 'subscription',
    });
  });

  test('registers Gemini CLI (gemini-cli) under the google-code-assist vendor', () => {
    const cli = MODEL_REGISTRY['gemini-cli']!;
    expect(cli).toMatchObject({
      id: 'gemini-cli',
      lab: 'google',
      type: 'gemini-cli',
      label: 'Gemini CLI',
      credential: 'subscription',
      enabledByDefault: false,
    });
    expect(cli.envKey).toBeUndefined();
    expect(cli.models.map((m) => m.id)).toEqual([
      'gemini-4-argon',
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ]);
    for (const model of cli.models) {
      expect(model.runtimeKind).toBe('native-harness');
      expect(model.reasoning).toEqual({
        param: 'thinking_level',
        efforts: ['low', 'medium', 'high'],
        fallback: 'medium',
      });
    }
    expect(SUBSCRIPTION_WORKER_MODELS['gemini-cli']).toBe('gemini-3.8-flash');
    expect(vendorOfProvider('gemini-cli')).toMatchObject({
      vendor: { id: 'google-code-assist', label: 'Google Gemini CLI', lab: 'google' },
      mode: 'subscription',
    });
    expect(MODEL_VENDORS.find((v) => v.id === 'google')?.subscription).toEqual({ provider: 'agy' });
  });
});

describe('Model speed / fast mode registry metadata', () => {
  test('exposes speed tiers only for models that support fast mode or service tiers', () => {
    // Claude Code: Opus & Fable 5.2 support fast mode; Sonnet, Haiku, and Fable 5.1 do not.
    expect(modelSpeeds('claude-code', 'claude-opus-5-5')).toEqual(['standard', 'fast']);
    expect(modelSpeeds('claude-code', 'opus')).toEqual(['standard', 'fast']);
    expect(modelSpeeds('claude-code', 'claude-fable-5-2')).toEqual(['standard', 'fast']);
    expect(modelSpeeds('claude-code', 'fable')).toEqual(['standard', 'fast']);
    expect(modelSpeeds('claude-code', 'claude-sonnet-5-5')).toEqual([]);
    expect(modelSpeeds('claude-code', 'claude-haiku-5-5')).toEqual([]);
    expect(modelSpeeds('claude-code', 'claude-fable-5-1')).toEqual([]);

    // Codex: all GPT-5.6/6.x models support standard/fast; 6.2 Astra & 6.1 Terra default to fast.
    expect(modelSpeeds('codex', 'gpt-6.2-astra')).toEqual(['standard', 'fast']);
    expect(registryModel('codex', 'gpt-6.2-astra')?.speed?.fallback).toBe('fast');
    expect(registryModel('codex', 'gpt-6.1-terra')?.speed?.fallback).toBe('fast');
    expect(modelSpeeds('codex', 'gpt-6.2-sol')).toEqual(['standard', 'fast']);
    expect(registryModel('codex', 'gpt-6.2-sol')?.speed?.fallback).toBe('standard');

    // Antigravity, Gemini CLI, and Muse do not expose speed tiers.
    expect(modelSpeeds('agy', 'gemini-4-neon')).toEqual([]);
    expect(modelSpeeds('gemini-cli', 'gemini-3.8-flash')).toEqual([]);
    expect(modelSpeeds('muse', 'muse-wonder-1.0')).toEqual([]);
    expect(modelSpeeds('claude-code', 'nonexistent-model')).toBeUndefined();
  });
});
