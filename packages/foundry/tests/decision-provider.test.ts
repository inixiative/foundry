import { expect, test } from 'bun:test';
import { DECISION_MODEL, DECISION_PROVIDER, modelHasCapability } from '../src/models/registry';
import { AnthropicProvider } from '../src/providers/anthropic';
import { createDecisionProvider, resolveDecisionModel } from '../src/providers/decision-provider';
import { OpenAIProvider } from '../src/providers/openai';
import { defaultConfig } from '../src/viewer/config';

function apiConfig(defaults: Record<string, string> = {}) {
  const config = defaultConfig();
  config.apiTokens = true;
  config.defaults = { ...config.defaults, ...defaults } as typeof config.defaults;
  return config;
}

test('the decision default is a registered judgment model, not a hardcoded id', () => {
  expect(modelHasCapability(DECISION_PROVIDER, DECISION_MODEL, 'judgment')).toBe(true);
  expect([DECISION_PROVIDER, DECISION_MODEL]).toEqual(['anthropic', 'claude-haiku-5-5']);
  // defaultConfig names the subscription profile, which this path cannot construct.
  expect(resolveDecisionModel(defaultConfig())).toEqual({
    provider: DECISION_PROVIDER,
    model: DECISION_MODEL,
  });
  expect(
    resolveDecisionModel(
      apiConfig({ classifierProvider: 'deepseek', classifierModel: 'deepseek-flash' }),
    ),
  ).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
});

test('decisions fail before making requests when disabled or missing a credential', () => {
  const disabled = apiConfig();
  disabled.vendors.anthropic!.api!.enabled = false;
  expect(() => createDecisionProvider(disabled, { ANTHROPIC_API_KEY: 'controlled-key' })).toThrow(
    'require anthropic to be enabled',
  );
  for (const key of [undefined, '', ' '])
    expect(() => createDecisionProvider(apiConfig(), { ANTHROPIC_API_KEY: key })).toThrow(
      'ANTHROPIC_API_KEY',
    );
});

test('a model that is not tagged for judgment is refused', () => {
  const config = apiConfig({ classifierProvider: 'openai', classifierModel: 'not-a-model' });
  expect(() => createDecisionProvider(config, { OPENAI_API_KEY: 'controlled-key' })).toThrow(
    'tagged for judgment',
  );
});

test('any provider with a judgment model can run decisions, including a keyless local one', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; model: string }> = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url: String(url), model: body.model });
    return Response.json({ choices: [{ message: { content: 'ok' } }], model: body.model });
  }) as typeof fetch;
  try {
    const local = createDecisionProvider(
      apiConfig({ classifierProvider: 'ollama', classifierModel: 'llama3.2:3b' }),
      {},
    );
    expect(local.id).toBe('ollama-decisions');
    await local.complete([{ role: 'user', content: 'decide' }], { maxTokens: 16 });
    expect(calls[0]).toEqual({
      url: 'http://localhost:11434/v1/chat/completions',
      model: 'llama3.2:3b',
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('decision and Anthropic worker identities coexist and decisions run Haiku 5.5', async () => {
  const original = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    models.push(body.model);
    return Response.json({
      content: [{ type: 'text', text: 'ok' }],
      model: body.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }) as typeof fetch;
  try {
    const decisions = createDecisionProvider(apiConfig(), { ANTHROPIC_API_KEY: 'controlled-key' });
    const worker = new AnthropicProvider({
      apiKey: 'controlled-key',
      defaultModel: 'claude-fable-5-1',
    });
    expect([decisions.id, worker.id]).toEqual(['anthropic-decisions', 'anthropic']);
    await decisions.complete([{ role: 'user', content: 'decide' }], { maxTokens: 16 });
    await worker.complete([{ role: 'user', content: 'work' }], { maxTokens: 16 });
    expect(models).toEqual(['claude-haiku-5-5', 'claude-fable-5-1']);
  } finally {
    globalThis.fetch = original;
  }
});

test('decision and OpenAI worker identities coexist and OpenAI decisions run Luna', async () => {
  const original = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    models.push(body.model);
    return Response.json({ choices: [{ message: { content: 'ok' } }], model: body.model });
  }) as typeof fetch;
  try {
    const decisions = createDecisionProvider(
      apiConfig({ classifierProvider: 'openai', classifierModel: 'gpt-6-luna' }),
      { OPENAI_API_KEY: 'controlled-key' },
    );
    const worker = new OpenAIProvider({ apiKey: 'controlled-key', defaultModel: 'gpt-6-sol' });
    const providers = new Map([
      [decisions.id, decisions],
      [worker.id, worker],
    ]);
    expect(providers.size).toBe(2);
    await providers
      .get(decisions.id)!
      .complete([{ role: 'user', content: 'decide' }], { maxTokens: 16 });
    await providers
      .get(worker.id)!
      .complete([{ role: 'user', content: 'work' }], { maxTokens: 16 });
    expect(models).toEqual(['gpt-6-luna', 'gpt-6-sol']);
  } finally {
    globalThis.fetch = original;
  }
});
