import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  type AssembledContext,
  assembledToMessages,
  type LLMMessage,
  type PromptBlock,
  splitSystemMessage,
} from '@inixiative/foundry-core';
import { AnthropicProvider } from '../src/providers/anthropic';
import { GeminiProvider } from '../src/providers/gemini';
import { OpenAIProvider } from '../src/providers/openai';

// ---------------------------------------------------------------------------
// assembledToMessages
// ---------------------------------------------------------------------------

/** A test double for the global fetch; Bun's fetch type also carries preconnect. */
const fakeFetch = (
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch => Object.assign(impl, { preconnect: fetch.preconnect });

describe('assembledToMessages', () => {
  test('converts full assembled context to messages', () => {
    const assembled: AssembledContext = {
      blocks: [
        { role: 'system', text: 'You are a classifier.' },
        { role: 'layer', id: 'conventions', text: 'Follow these rules.' },
        { role: 'content', id: 'conventions', text: 'Use snake_case.' },
        { role: 'layer', id: 'taxonomy', text: 'Classify with this.' },
        { role: 'content', id: 'taxonomy', text: 'bug | feature | chore' },
      ],
      text: 'You are a classifier.\n\nFollow these rules.\n\nUse snake_case.\n\nClassify with this.\n\nbug | feature | chore',
    };

    const messages = assembledToMessages(assembled, 'classify this ticket');

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('You are a classifier.');
    expect(messages[0].content).toContain('[conventions]: Follow these rules.');
    expect(messages[0].content).toContain('Use snake_case.');
    expect(messages[0].content).toContain('[taxonomy]: Classify with this.');
    expect(messages[0].content).toContain('bug | feature | chore');
    expect(messages[1]).toEqual({
      role: 'user',
      content: 'classify this ticket',
    });
  });

  test('handles empty assembled context', () => {
    const assembled: AssembledContext = { blocks: [], text: '' };
    const messages = assembledToMessages(assembled, 'hello');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'user', content: 'hello' });
  });

  test('handles system-only blocks', () => {
    const assembled: AssembledContext = {
      blocks: [{ role: 'system', text: 'You are helpful.' }],
      text: 'You are helpful.',
    };
    const messages = assembledToMessages(assembled, 'hi');

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('You are helpful.');
  });
});

// ---------------------------------------------------------------------------
// splitSystemMessage
// ---------------------------------------------------------------------------

describe('splitSystemMessage', () => {
  test('separates system messages from turns', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];

    const { system, turns } = splitSystemMessage(messages);

    expect(system).toBe('You are a bot.');
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
  });

  test('handles no system message', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];
    const { system, turns } = splitSystemMessage(messages);

    expect(system).toBeUndefined();
    expect(turns).toHaveLength(1);
  });

  test('concatenates multiple system messages', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'Part 1.' },
      { role: 'system', content: 'Part 2.' },
      { role: 'user', content: 'Go' },
    ];

    const { system, turns } = splitSystemMessage(messages);
    expect(system).toBe('Part 1.\n\nPart 2.');
    expect(turns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Provider construction and configuration
// ---------------------------------------------------------------------------

describe('AnthropicProvider', () => {
  test('constructs with defaults', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    expect(provider.id).toBe('anthropic');
  });

  test('throws on API error', async () => {
    // Mock fetch to return an error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(async () => new Response('Unauthorized', { status: 401 }));

    const provider = new AnthropicProvider({ apiKey: 'bad-key' });

    try {
      await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        'Anthropic API 401',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('sends correct request format', async () => {
    let capturedBody: any;
    let capturedHeaders: any;
    let capturedUrl = '';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(async (url: any, init: any) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'response' }],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'end_turn',
        }),
      );
    });

    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      defaultModel: 'claude-sonnet-4-20250514',
    });

    try {
      const result = await provider.complete(
        [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: 'Hello' },
        ],
        { temperature: 0.5, maxTokens: 256 },
      );

      // Verify request
      expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
      expect(capturedHeaders['x-api-key']).toBe('sk-test');
      expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
      expect(capturedBody.model).toBe('claude-sonnet-4-20250514');
      expect(capturedBody.system).toBe('Be helpful.');
      expect(capturedBody.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(capturedBody.max_tokens).toBe(256);
      expect(capturedBody.temperature).toBe(0.5);

      // Verify response
      expect(result.content).toBe('response');
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.tokens).toMatchObject({ input: 10, output: 5 });
      expect(result.finishReason).toBe('end_turn');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('respects baseUrl override', async () => {
    let capturedUrl: string = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(async (url: any, init: any) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '' }],
          model: 'test',
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'end_turn',
        }),
      );
    });

    const provider = new AnthropicProvider({
      apiKey: 'key',
      baseUrl: 'https://proxy.example.com',
    });

    try {
      await provider.complete([{ role: 'user', content: 'test' }]);
      expect(capturedUrl).toBe('https://proxy.example.com/v1/messages');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('OpenAIProvider', () => {
  test('constructs with defaults', () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    expect(provider.id).toBe('openai');
  });

  test('sends correct request format', async () => {
    let capturedBody: any;
    let capturedHeaders: any;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'response' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });

    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    try {
      const result = await provider.complete([
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Hello' },
      ]);

      // System message stays inline for OpenAI
      expect(capturedBody.messages).toEqual([
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Hello' },
      ]);
      expect(capturedHeaders.authorization).toBe('Bearer sk-test');
      expect(result.content).toBe('response');
      expect(result.tokens).toEqual({ input: 10, output: 5 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws on API error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(async () => new Response('Rate limited', { status: 429 }));

    const provider = new OpenAIProvider({ apiKey: 'key' });

    try {
      await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        'OpenAI API 429',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('GeminiProvider', () => {
  test('constructs with defaults', () => {
    const provider = new GeminiProvider({ apiKey: 'test-key' });
    expect(provider.id).toBe('gemini');
    expect(provider.imageInput).toBe(true);
  });

  test('defaults to gemini-3.5-flash-lite', async () => {
    let capturedUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(async (url) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        }),
      );
    });

    const provider = new GeminiProvider({ apiKey: 'test-key' });
    try {
      const result = await provider.complete([{ role: 'user', content: 'hi' }]);
      expect(capturedUrl).toContain('/v1beta/models/gemini-3.5-flash-lite:generateContent');
      expect(result.model).toBe('gemini-3.5-flash-lite');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('sends correct request format', async () => {
    let capturedBody: any;
    let capturedUrl: string = '';
    let capturedHeaders: any;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(async (url: any, init: any) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: 'response' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
          },
        }),
      );
    });

    const provider = new GeminiProvider({
      apiKey: 'gem-key',
      defaultModel: 'gemini-2.5-flash',
    });

    try {
      const result = await provider.complete(
        [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: 'Hello' },
        ],
        { temperature: 0.7, maxTokens: 512 },
      );

      // API key should be in header, not URL
      expect(capturedUrl).toContain('gemini-2.5-flash:generateContent');
      expect(capturedUrl).not.toContain('key=');
      expect(capturedHeaders['x-goog-api-key']).toBe('gem-key');
      expect(capturedBody.system_instruction).toEqual({
        parts: [{ text: 'Be helpful.' }],
      });
      expect(capturedBody.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
      expect(capturedBody.generationConfig.temperature).toBe(0.7);
      expect(capturedBody.generationConfig.maxOutputTokens).toBe(512);

      expect(result.content).toBe('response');
      expect(result.tokens).toEqual({ input: 10, output: 5 });
      expect(result.finishReason).toBe('STOP');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('maps assistant role to model', async () => {
    let capturedBody: any;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
        }),
      );
    });

    const provider = new GeminiProvider({ apiKey: 'key' });

    try {
      await provider.complete([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'How are you?' },
      ]);

      expect(capturedBody.contents[1].role).toBe('model');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('maps thinking option to generationConfig.thinkingConfig', async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(async (_url, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        }),
      );
    });

    const provider = new GeminiProvider({ apiKey: 'key', defaultModel: 'gemini-4-argon' });
    try {
      await provider.complete([{ role: 'user', content: 'a' }], { thinking: 'high' });
      await provider.complete([{ role: 'user', content: 'b' }], { thinking: 'none' });
      await provider.complete([{ role: 'user', content: 'c' }], { thinking: 4096 });
      await provider.complete([{ role: 'user', content: 'd' }], {
        model: 'gemini-custom-unregistered',
        thinking: 'high',
      });

      expect(
        (capturedBodies[0]?.generationConfig as Record<string, unknown>)?.thinkingConfig,
      ).toEqual({ thinkingLevel: 'HIGH' });
      // Gemini models in the registry do not accept "none"; fall back to their registry fallback ("medium").
      expect(
        (capturedBodies[1]?.generationConfig as Record<string, unknown>)?.thinkingConfig,
      ).toEqual({ thinkingLevel: 'MEDIUM' });
      expect(
        (capturedBodies[2]?.generationConfig as Record<string, unknown>)?.thinkingConfig,
      ).toEqual({ thinkingBudget: 4096 });
      expect(capturedBodies[3]?.generationConfig).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('maps LLMMessage.images to inlineData parts and rejects missing image bytes', async () => {
    let capturedBody: Record<string, unknown> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'a cat' }] }, finishReason: 'STOP' }],
        }),
      );
    });

    const provider = new GeminiProvider({ apiKey: 'key' });
    try {
      await provider.complete([
        {
          role: 'user',
          content: 'What is this?',
          images: [{ id: 'img-1', mediaType: 'image/png', bytes: 4, data: 'AQIDBA==' }],
        },
      ]);

      expect(capturedBody.contents).toEqual([
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/png', data: 'AQIDBA==' } },
            { text: 'What is this?' },
          ],
        },
      ]);

      await expect(
        provider.complete([
          {
            role: 'user',
            content: 'Missing bytes',
            images: [{ id: 'img-2', mediaType: 'image/jpeg', bytes: 10 }],
          },
        ]),
      ).rejects.toThrow('Image img-2 has no data');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('filters thought parts and parses thoughtsTokenCount and cachedContentTokenCount', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'internal reasoning', thought: true }, { text: 'final answer' }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 1000,
              cachedContentTokenCount: 600,
              candidatesTokenCount: 120,
              thoughtsTokenCount: 280,
            },
          }),
        ),
    );

    const provider = new GeminiProvider({ apiKey: 'key', defaultModel: 'gemini-4-argon' });
    try {
      const result = await provider.complete([{ role: 'user', content: 'solve' }], {
        thinking: 'medium',
      });

      expect(result.content).toBe('final answer');
      expect(result.tokens).toEqual({
        input: 400,
        output: 400,
        cacheRead: 600,
        thinking: 280,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
