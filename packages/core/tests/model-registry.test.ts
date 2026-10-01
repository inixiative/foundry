import { describe, expect, test } from 'bun:test';
import {
  DECISION_MODEL,
  DECISION_PROVIDER,
  MODEL_CAPABILITIES,
  MODEL_REGISTRY,
  type ModelCapability,
  modelCapabilities,
  modelHasCapability,
  modelOptionsByCapability,
  providersWithCapability,
  registryModel,
  resolveDecisionModel,
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
    expect(Object.keys(dependencies)).toEqual(['uuidv7']);
  });

  test('resolveDecisionModel falls back to the registry defaults', () => {
    expect(resolveDecisionModel({ defaults: {} })).toEqual({
      provider: DECISION_PROVIDER,
      model: DECISION_MODEL,
    });
    expect(
      resolveDecisionModel({
        defaults: { classifierProvider: 'deepseek', classifierModel: 'deepseek-flash' },
      }),
    ).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    // The subscription decision profile is not a registered provider: it belongs
    // to the native path, so the API-token resolver hands back its own defaults.
    expect(
      resolveDecisionModel({
        defaults: { classifierProvider: 'subscription-decisions', classifierModel: 'gpt-6-luna' },
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
