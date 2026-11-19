import { describe, expect, test } from 'bun:test';
import { ContextLayer, type ContextSource } from '../src/context-layer';
import { ContextStack } from '../src/context-stack';
import { Executor } from '../src/executor';
import type { InjectionArtifact } from '../src/messages';

function source(id: string, content: string): ContextSource {
  return { id, load: async () => content };
}

function makeStack(...layers: [string, string][]): ContextStack {
  return new ContextStack(
    layers.map(([id, content]) => {
      const l = new ContextLayer({ id, sources: [source(id, content)] });
      l.set(content);
      return l;
    }),
  );
}

describe('Executor', () => {
  test('runs handler with merged context', async () => {
    const stack = makeStack(['docs', 'Use TypeScript']);
    const executor = new Executor({
      id: 'writer',
      stack,
      handler: async (context, payload: string) => {
        return `Context: ${context}, Payload: ${payload}`;
      },
    });

    const result = await executor.run('write code');
    expect(result.output).toBe('Context: Use TypeScript, Payload: write code');
    expect(result.contextHash).toBeTruthy();
  });

  test('respects filterOverride', async () => {
    const stack = makeStack(['docs', 'docs content'], ['memory', 'memory content']);
    const executor = new Executor({
      id: 'writer',
      stack,
      handler: async (context, _payload: string) => context,
    });

    const result = await executor.run('test', (l) => l.id === 'docs');
    expect(result.output).toBe('docs content');
    expect(result.output).not.toContain('memory content');
  });

  test('respects layerFilter from config', async () => {
    const stack = makeStack(['docs', 'docs content'], ['memory', 'memory content']);
    const executor = new Executor({
      id: 'writer',
      stack,
      layerFilter: (l) => l.id === 'docs',
      handler: async (context, _payload: string) => context,
    });

    const result = await executor.run('test');
    expect(result.output).toBe('docs content');
  });

  test('returns an injection artifact in metadata', async () => {
    const stack = makeStack(
      ['conventions', 'Use existing primitives.'],
      ['__thread-state', 'Graph approved.'],
    );
    stack.getLayer('conventions')!.prompt = 'Project conventions.';

    const executor = new Executor({
      id: 'writer',
      stack,
      prompt: 'You are the Artificer.',
      handler: async (context, _payload: string) => context,
    });

    const result = await executor.run('build the loop');
    const injection = result.meta?.injection as InjectionArtifact | undefined;

    expect(injection).toBeDefined();
    expect(injection?.userMessage).toBe('build the loop');
    expect(injection?.text).toContain('# User Message');
    expect(injection?.text).toContain('## Instructions');
    expect(injection?.text).toContain('## Domain Knowledge');
    expect(injection?.text).toContain('## Thread State');
    expect(injection?.blocks.map((block) => block.kind)).toEqual([
      'instructions',
      'instructions',
      'domain-knowledge',
      'thread-knowledge',
    ]);
  });
});

describe('Agent prompt-layer pairing', () => {
  test('assembleContext includes agent prompt and layer prompts', () => {
    const stack = new ContextStack(
      (
        [
          ['conventions', 'Use TypeScript strict mode'],
          ['taxonomy', 'bug | feature | chore'],
        ] as const
      ).map(([id, content]) => {
        const l = new ContextLayer({
          id,
          sources: [source(id, content)],
          prompt:
            id === 'conventions'
              ? 'Follow these project conventions.'
              : 'Classify using this taxonomy.',
        });
        l.set(content);
        return l;
      }),
    );

    const executor = new Executor({
      id: 'classifier',
      stack,
      prompt: 'You are a message classifier.',
      handler: async (context, payload: string) => context,
    });

    const assembled = executor.assembleContext();
    expect(assembled.blocks[0]).toEqual({
      role: 'system',
      text: 'You are a message classifier.',
    });
    expect(assembled.blocks.length).toBe(5);
    expect(assembled.text).toContain('You are a message classifier.');
    expect(assembled.text).toContain('Follow these project conventions.');
    expect(assembled.text).toContain('Use TypeScript strict mode');
  });

  test('assembleContext respects filterOverride', () => {
    const stack = makeStack(['docs', 'docs content'], ['memory', 'memory content']);
    // Add prompt to docs layer
    stack.getLayer('docs')!.prompt = 'Reference documentation.';

    const executor = new Executor({
      id: 'writer',
      stack,
      prompt: 'You are a writer.',
      handler: async (ctx) => ctx,
    });

    const assembled = executor.assembleContext((l) => l.id === 'docs');
    expect(assembled.blocks.length).toBe(3); // system + layer prompt + content
    expect(assembled.text).not.toContain('memory content');
    expect(assembled.text).toContain('Reference documentation.');
  });

  test('assembleContext without agent prompt', () => {
    const stack = makeStack(['docs', 'docs content']);
    stack.getLayer('docs')!.prompt = 'Reference docs.';

    const executor = new Executor({
      id: 'writer',
      stack,
      handler: async (ctx) => ctx,
    });

    const assembled = executor.assembleContext();
    expect(assembled.blocks[0].role).toBe('layer');
    expect(assembled.blocks.length).toBe(2);
  });
});
