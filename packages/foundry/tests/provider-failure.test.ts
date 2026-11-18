import { expect, test } from 'bun:test';
import { ContextStack, Harness, type LLMProvider } from '@inixiative/foundry-core';
import { buildAgents, ThreadFactory } from '../src/agents/thread-factory';
import { starterConfig } from '../src/viewer/config';

for (const streaming of [false, true]) {
  test(`production ${streaming ? 'streaming' : 'complete'} provider errors are failures, not successful assistant text`, async () => {
    const config = starterConfig('mock', 'mock');
    config.agents = {
      worker: {
        id: 'worker',
        kind: 'executor',
        provider: 'mock',
        model: 'mock',
        prompt: '',
        temperature: 0,
        visibleLayers: [],
        peers: [],
        maxDepth: 1,
        enabled: true,
      },
    };
    const stack = new ContextStack();
    const provider: LLMProvider = {
      id: 'mock',
      complete: async () => {
        throw new Error('native work outcome unknown');
      },
      stream: async function* () {
        yield { type: 'error' as const, error: 'native work outcome unknown' };
      },
    };
    const thread = new ThreadFactory({
      stack,
      agents: buildAgents(config, stack, { provider }),
    }).create('failed-provider');
    const harness = new Harness(thread);
    harness.setDefaultExecutor('worker');
    const observations: unknown[] = [];
    thread.signals.on('dispatch', (signal) => {
      observations.push(signal.content);
    });
    try {
      if (streaming) {
        await expect(
          (async () => {
            for await (const _ of harness.sendStream({ id: 'turn', payload: 'Do work' })) {
            }
          })(),
        ).rejects.toThrow('outcome unknown');
      } else
        await expect(harness.send({ id: 'turn', payload: 'Do work' })).rejects.toThrow(
          'outcome unknown',
        );
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({ ok: false, error: 'native work outcome unknown' });
    } finally {
      thread.dispose();
    }
  });
}
