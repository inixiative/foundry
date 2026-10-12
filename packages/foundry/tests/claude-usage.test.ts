import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicProvider } from '../src/providers/anthropic';

const stubFetch = (
  respond: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch => Object.assign(respond, { preconnect: fetch.preconnect });

const usage = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 200,
  cache_creation: { ephemeral_1h_input_tokens: 200 },
  output_tokens_details: { thinking_tokens: 12 },
  service_tier: 'standard',
  future_tag: true,
};
const expected = {
  input: 10,
  output: 20,
  cacheRead: 1000,
  cacheWrite: 200,
  cacheWrite1h: 200,
  thinking: 12,
  providerUsage: usage,
};

describe('Claude provider usage', () => {
  test('Anthropic completion and SSE preserve cache-only usage across split chunks', async () => {
    const originalFetch = globalThis.fetch;
    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    try {
      globalThis.fetch = stubFetch(
        async () =>
          new Response(
            JSON.stringify({ content: [], model: 'test-model', usage, stop_reason: 'end_turn' }),
          ),
      );
      expect((await provider.complete([{ role: 'user', content: 'test' }])).tokens).toEqual(
        expected,
      );
      const cacheOnly = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 500,
        service_tier: 'standard',
      };
      const chunks = [
        'event: message_start\n',
        `data: ${JSON.stringify({ message: { usage: cacheOnly } })}\n\n`,
        'event: message_delta\n',
        `data: ${JSON.stringify({ usage: { output_tokens: 0 }, delta: { stop_reason: 'end_turn' } })}\n\n`,
      ];
      globalThis.fetch = stubFetch(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
              },
            }),
          ),
      );
      const events = await Array.fromAsync(provider.stream([{ role: 'user', content: 'test' }]));
      expect(events.find((e) => e.type === 'usage')?.tokens).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 500,
        providerUsage: cacheOnly,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
