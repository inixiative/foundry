import { expect, test } from 'bun:test';
import {
  type CompletionOpts,
  ContextStack,
  type LLMProvider,
  type ScriptResult,
  type ScriptTool,
  Thread,
  ToolRegistry,
  type ToolResult,
} from '@inixiative/foundry-core';
import { buildAgents } from '../src/agents/thread-factory';
import { starterConfig } from '../src/viewer/config';

function tools() {
  const registry = new ToolRegistry();
  const noop: ScriptTool = {
    id: 'noop',
    kind: 'script',
    capability: 'data:read',
    async evaluate<T>(): Promise<ToolResult<ScriptResult<T>>> {
      return { ok: true, data: { result: null as T, logs: [], durationMs: 0 }, summary: 'ok' };
    },
  };
  registry.register(noop, 'Does nothing');
  return registry;
}

for (const withTools of [true, false])
  test(`the executor's provider call runs in the thread's working directory (${withTools ? 'tool loop' : 'plain'})`, async () => {
    const seen: CompletionOpts[] = [];
    const provider: LLMProvider = {
      id: 'central',
      async complete(_messages, opts = {}) {
        seen.push(opts);
        return { model: 'controlled', content: 'done' };
      },
    };
    const config = starterConfig('central', 'central-model');
    config.agents = {
      worker: {
        id: 'worker',
        kind: 'executor',
        prompt: 'Work',
        provider: 'central',
        model: 'central-model',
        visibleLayers: [],
        peers: [],
        maxDepth: 1,
        enabled: true,
      },
    };
    const stack = new ContextStack();
    const agents = buildAgents(config, stack, {
      provider,
      ...(withTools ? { tools: tools() } : {}),
    });
    const thread = new Thread('t', stack, { cwd: '/work/zealot' });
    thread.register(agents.get('worker')!.withStack(stack));
    await thread.dispatch('worker', 'Do the work');
    expect(seen.length).toBeGreaterThan(0);
    for (const opts of seen) expect(opts.cwd).toBe('/work/zealot');
  });
