import { expect, test } from 'bun:test';
import { ContextLayer, type ContextSource } from '../src/context-layer';
import { ContextStack } from '../src/context-stack';
import { Executor } from '../src/executor';
import { Harness } from '../src/harness';
import type { SessionDelivery } from '../src/session-delivery';
import { Thread } from '../src/thread';

/** A source whose backing text an edit changes; `changed()` reports it the way a file check would. */
function editable(id: string, initial: string, opts: { focusable?: boolean } = {}) {
  let text = initial;
  let loaded: string | undefined;
  const source: ContextSource = {
    id,
    ...(opts.focusable ? { focusable: true } : {}),
    load: async () => {
      loaded = text;
      return text;
    },
    changed: () => loaded !== undefined && loaded !== text,
  };
  return {
    source,
    edit(next: string) {
      text = next;
    },
  };
}

test('a source that reports a change makes its warm layer stale without waiting out its window', async () => {
  const file = editable('instructions-src', 'RULE v1');
  const layer = new ContextLayer({ id: 'instructions', staleness: 60_000, sources: [file.source] });
  await layer.warm();
  expect(layer.checkStaleness()).toBe('warm');
  file.edit('RULE v2');
  expect(layer.checkStaleness()).toBe('stale');
  await layer.warm();
  expect(layer.content).toBe('RULE v2');
  expect(layer.checkStaleness()).toBe('warm');
});

test('a stale standing layer keeps assembling its last content; a stale selection does not', async () => {
  const standing = editable('instructions-src', 'RULE v1');
  const selection = editable('memory-src', 'SELECTED', { focusable: true });
  const instructions = new ContextLayer({
    id: 'instructions',
    staleness: 1,
    sources: [standing.source],
  });
  const memory = new ContextLayer({ id: 'memory', sources: [selection.source] });
  const stack = new ContextStack([instructions, memory]);
  await stack.warmAll();
  await Bun.sleep(5);
  expect(instructions.checkStaleness()).toBe('stale');
  memory.setFocus('a different message');
  expect(memory.state).toBe('stale');
  const text = stack.assemble().text;
  // The review's repro: a stale layer used to vanish from assembly. Standing content stays; a
  // selection made for another message never answers this one.
  expect(text).toContain('RULE v1');
  expect(text).not.toContain('SELECTED');
});

test('a per-turn layer rides with the turn and never becomes a standing part', async () => {
  const state = new ContextLayer({ id: 'thread-state', prompt: 'Thread state.', perTurn: true });
  state.set('{"messageCount":3}');
  const rules = new ContextLayer({ id: 'instructions' });
  rules.set('RULES');
  const stack = new ContextStack([state, rules]);
  let delivery: SessionDelivery | undefined;
  const executor = new Executor<string, string>({
    id: 'worker',
    stack,
    handler: async (context, _payload, meta) => {
      delivery = meta?.delivery;
      return context;
    },
  });
  const result = await executor.run('go');
  expect(result.output).toContain('messageCount');
  expect(delivery!.standing.map((part) => part.id)).toEqual(['instructions']);
  expect(delivery!.turn).toBe('Thread state.\n\n{"messageCount":3}');
  expect(state.clone().perTurn).toBe(true);
});

test('a dispatch middleware can request an on-demand layer for the executor it wraps', async () => {
  const onDemand = new ContextLayer({ id: 'conventions' });
  onDemand.set('ON_DEMAND_CONVENTIONS');
  const stack = new ContextStack([onDemand]);
  const thread = new Thread('t', stack);
  thread.register(
    new Executor<string, string>({ id: 'worker', stack, handler: async (context) => context }),
  );
  const harness = new Harness(thread);
  harness.setDefaultExecutor('worker');
  harness.setLayerMode('conventions', 'on-demand');
  const before = await harness.send({ id: 'm1', payload: 'go' });
  expect(before.result.output).not.toContain('ON_DEMAND_CONVENTIONS');
  thread.middleware.use('plan', async (ctx, next) => {
    ctx.requestLayer?.('conventions');
    return next();
  });
  const after = await harness.send({ id: 'm2', payload: 'go' });
  expect(after.result.output).toContain('ON_DEMAND_CONVENTIONS');
});

test('a standing layer keeps assembling while a slow re-warm is in flight', async () => {
  let text = 'RULE v1';
  let release!: () => void;
  let slow = false;
  const layer = new ContextLayer({
    id: 'instructions',
    sources: [
      {
        id: 'src',
        load: async () => {
          if (slow) await new Promise<void>((resolve) => (release = resolve));
          return text;
        },
      },
    ],
  });
  const stack = new ContextStack([layer]);
  await layer.warm();
  slow = true;
  text = 'RULE v2';
  layer.invalidate();
  const warming = layer.warm();
  expect(layer.state).toBe('warming');
  expect(stack.assemble().text).toContain('RULE v1');
  release();
  await warming;
  expect(stack.assemble().text).toContain('RULE v2');
});
