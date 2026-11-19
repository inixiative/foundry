import { afterEach, expect, test } from 'bun:test';
import {
  type CompletionOpts,
  ContextLayer,
  ContextStack,
  callOutcomeLabel,
  type LLMMessage,
  SignalBus,
} from '@inixiative/foundry-core';
import { degradedAnswer } from '../src/agents/chorus-degraded';
import { FlowOrchestrator } from '../src/agents/flow-orchestrator';
import { Librarian } from '../src/agents/librarian';
import { Warden } from '../src/agents/warden';
import {
  CATCH_UP_MAX_CHARS,
  CATCH_UP_MAX_MESSAGES,
  type CatchUpRow,
  WardenCatchUp,
} from '../src/agents/warden-catch-up';
import { NO_COMMENT } from '../src/classify';
import { NOT_HELD_REFUSAL, QUOTA_PAUSED_REFUSAL } from '../src/providers/decision-budget';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const text = (messages: readonly LLMMessage[]) => messages.map((m) => m.content).join('\n');
const said = (domain = 'a') => [
  { domain, outcome: { status: 'answered', result: 'no-comment' } as const },
];

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

test('a Warden first asked starts at the current message; one that missed messages gets them, oldest first', () => {
  const c = new WardenCatchUp();
  const m1 = c.message('one');
  expect(c.missedBy('a', m1)).toBeUndefined();
  c.answered(m1, said());
  const m2 = c.message('two');
  // Not answered (skipped unsent, timed out, errored): the cursor stays at m1.
  expect(c.missedBy('a', m2)).toBeUndefined();
  c.answered(m2, [{ domain: 'a', outcome: { status: 'not-sent', cause: 'not-admitted' } }]);
  const m3 = c.message('three');
  c.answered(m3, [{ domain: 'a', outcome: { status: 'failed', cause: 'timeout' } }]);
  const m4 = c.message('four');
  expect(c.missedBy('a', m4)).toEqual({ messages: ['two', 'three'], dropped: 0 });
  c.answered(m4, said());
  expect(c.missedBy('a', c.message('five'))).toBeUndefined();
  // A Warden added mid-thread is not handed the thread's history.
  expect(c.missedBy('b', c.current)).toBeUndefined();
  c.answered(c.current, [{ domain: 'b', outcome: { status: 'not-sent', cause: 'not-admitted' } }]);
  expect(c.missedBy('b', c.message('six'))).toEqual({ messages: ['five'], dropped: 0 });
});

test('catching up is capped by count and size, the rest counted; the current message is always whole', () => {
  const c = new WardenCatchUp();
  c.answered(c.message('start'), said());
  for (let i = 1; i <= 7; i++) c.message(`missed ${i}`);
  const now = c.message('now');
  // At most CATCH_UP_MAX_MESSAGES, the current one included: the newest four missed, three counted.
  expect(c.missedBy('a', now)).toEqual({
    messages: ['missed 4', 'missed 5', 'missed 6', 'missed 7'],
    dropped: 3,
  });
  expect(CATCH_UP_MAX_MESSAGES).toBe(5);
  const big = new WardenCatchUp();
  big.answered(big.message('start'), said());
  big.message('x'.repeat(CATCH_UP_MAX_CHARS / 2));
  big.message('y'.repeat(CATCH_UP_MAX_CHARS / 2));
  const current = big.message('z'.repeat(100));
  // The newer half fits beside the current message; the older one would pass the size cap.
  expect(big.missedBy('a', current)).toEqual({
    messages: ['y'.repeat(CATCH_UP_MAX_CHARS / 2)],
    dropped: 1,
  });
});

test('a NO_COMMENT counts as answered; a skip does not; cursors never move back', () => {
  const c = new WardenCatchUp();
  c.answered(c.message('one'), said());
  const m2 = c.message('two');
  c.answered(m2, [
    { domain: 'a', outcome: { status: 'answered', result: 'no-comment' } },
    { domain: 'b', outcome: { status: 'not-sent', cause: 'cold' } },
  ]);
  const m3 = c.message('three');
  expect(c.missedBy('a', m3)).toBeUndefined();
  // b was first seen at m2 (starting at m1) and did not answer it.
  expect(c.missedBy('b', m3)).toEqual({ messages: ['two'], dropped: 0 });
  c.answered(m3, said());
  c.answered(m2, said());
  expect(c.missedBy('a', c.message('four'))).toBeUndefined();
});

test('a duplicate prepare of one message keeps its number; a Retry that answers moves the cursor', () => {
  const c = new WardenCatchUp();
  c.answered(c.message('one', 'msg-1'), said());
  const m2 = c.message('two', 'msg-2');
  expect(c.message('two', 'msg-2')).toBe(m2);
  c.answered(m2, [{ domain: 'a', outcome: { status: 'failed', cause: 'timeout' } }]);
  c.answeredMoment('two', said());
  expect(c.missedBy('a', c.message('three', 'msg-3'))).toBeUndefined();
});

test('restore rebuilds messages and cursors from the journalled advice rows', () => {
  const row = (id: string, turnId: string | null, record: Record<string, unknown>): CatchUpRow => ({
    id,
    turnId,
    record,
  });
  const rows: CatchUpRow[] = [
    row('r1', 't1', {
      trigger: 'user-message',
      moment: 'one',
      participants: [
        { domain: 'a', outcome: { status: 'answered', result: 'no-comment' } },
        { domain: 'b', outcome: { status: 'answered', result: 'spoke' } },
      ],
    }),
    row('r2', 't2', {
      trigger: 'user-message',
      moment: 'two',
      participants: [
        { domain: 'a', outcome: { status: 'not-sent', cause: 'not-held' }, catchesUp: true },
        { domain: 'b', outcome: { status: 'failed', cause: 'timeout' } },
      ],
    }),
    // A brief or a consumed item is not a user message.
    row('r3', 't2', { trigger: 'subagent-spawn', moment: 'brief', participants: [] }),
    // b's Retry on message two answered it.
    row('r4', null, {
      trigger: 'user-message',
      retryOf: 'r2',
      participants: [{ domain: 'b', outcome: { status: 'answered', result: 'no-comment' } }],
    }),
    row('r5', 't3', {
      trigger: 'user-message',
      moment: 'three',
      participants: [{ domain: 'b', outcome: { status: 'failed', cause: 'provider-error' } }],
    }),
  ];
  const c = new WardenCatchUp();
  c.restore(rows);
  expect(c.current).toBe(3);
  const now = c.message('four');
  expect(c.missedBy('a', now)).toEqual({ messages: ['two', 'three'], dropped: 0 });
  expect(c.missedBy('b', now)).toEqual({ messages: ['three'], dropped: 0 });
});

// ---------------------------------------------------------------------------
// The chorus
// ---------------------------------------------------------------------------

function chorus(answer: (message: string, opts: CompletionOpts | undefined) => string) {
  const signals = new SignalBus();
  const cache = new ContextLayer({ id: 'schema', segment: 'domain-knowledge' });
  cache.set('Prisma `schema.prisma`: false polymorphism.');
  const stack = new ContextStack([cache]);
  const librarian = new Librarian({ stack, signals });
  const asked: Array<{ message: string; heldOnly?: boolean }> = [];
  const lib = new Warden({
    domain: 'schema',
    cache,
    signals,
    llm: {
      id: 'host',
      complete: async (messages, opts) => {
        const message = text(messages);
        asked.push({ message, ...(opts?.heldOnly ? { heldOnly: true } : {}) });
        return { model: 'x', content: answer(message, opts) };
      },
    },
  });
  const flow = new FlowOrchestrator({
    stack,
    signals,
    librarian,
    wardens: new Map([['schema', lib]]),
  });
  cleanups.push(() => {
    flow.dispose();
    librarian.dispose();
  });
  return { flow, asked };
}

const notHeld = () => {
  throw Object.assign(Error(NOT_HELD_REFUSAL), { notSentCause: 'not-held' });
};

test('a Warden not held warm is skipped unsent, not degraded, and catches up on the next user message', async () => {
  let held = false;
  const { flow, asked } = chorus((_message, opts) => {
    if (!held && opts?.heldOnly) notHeld();
    return NO_COMMENT;
  });
  const first = await flow.preMessage('Tidy the Prisma schema');
  const skipped = first.contributions[0]!;
  expect(skipped).toMatchObject({
    outcome: { status: 'not-sent', cause: 'not-held' },
    catchesUp: true,
  });
  expect(asked[0]!.heldOnly).toBe(true);
  // No Retry is offered: the next message carries it.
  expect(degradedAnswer(skipped)).toBeUndefined();
  held = true;
  const second = await flow.preMessage('Add an index');
  expect(second.contributions[0]).toMatchObject({
    outcome: { status: 'answered', result: 'no-comment' },
    earlier: { count: 1, dropped: 0 },
  });
  const last = asked.at(-1)!.message;
  expect(last).toContain('## Messages since you last answered (oldest first)');
  expect(last.indexOf('Tidy the Prisma schema')).toBeLessThan(
    last.indexOf('## Message\nAdd an index'),
  );
  // Answered: the third message carries nothing earlier.
  await flow.preMessage('Rename the column');
  expect(asked.at(-1)!.message).not.toContain('Messages since you last answered');
});

test('a Warden paused on a used-up login is skipped unsent, not degraded, and catches up after the reset', async () => {
  let paused = true;
  const { flow, asked } = chorus(() => {
    if (paused) throw Object.assign(Error(QUOTA_PAUSED_REFUSAL), { notSentCause: 'not-admitted' });
    return NO_COMMENT;
  });
  const first = await flow.preMessage('Tidy the Prisma schema');
  const skipped = first.contributions[0]!;
  expect(skipped).toMatchObject({
    outcome: { status: 'not-sent', cause: 'not-admitted' },
    catchesUp: true,
  });
  // The strip says it once; no degraded Warden and no Retry each round.
  expect(degradedAnswer(skipped)).toBeUndefined();
  paused = false;
  const second = await flow.preMessage('Add an index');
  expect(second.contributions[0]).toMatchObject({
    outcome: { status: 'answered', result: 'no-comment' },
  });
  expect(asked.at(-1)!.message).toContain('Tidy the Prisma schema');
});

test('a capacity refusal that is not the held-only skip is still degraded (Retry offered)', async () => {
  const { flow } = chorus(() => {
    throw Object.assign(Error('Subscription decision expired in queue'), {
      notSentCause: 'not-admitted',
    });
  });
  const plan = await flow.preMessage('Tidy the Prisma schema');
  const answer = plan.contributions[0]!;
  expect(callOutcomeLabel(answer.outcome)).toBe('not-sent:not-admitted');
  expect(answer.catchesUp).toBeUndefined();
  expect(degradedAnswer(answer)).toMatchObject({ domain: 'schema' });
});

test('a Retry on a user message is not held-only, and when it answers the Warden is not asked on that message again', async () => {
  let failing = true;
  const { flow, asked } = chorus(() => {
    if (failing) throw Error('model unavailable');
    return NO_COMMENT;
  });
  const first = await flow.preMessage('Tidy the Prisma schema');
  expect(callOutcomeLabel(first.contributions[0]!.outcome)).toBe('failed:provider-error');
  failing = false;
  const retried = await flow.retry('user-message', 'Tidy the Prisma schema', ['schema']);
  expect(callOutcomeLabel(retried.contributions[0]!.outcome)).toBe('answered:no-comment');
  expect(asked.at(-1)!.heldOnly).toBeUndefined();
  await flow.preMessage('Add an index');
  expect(asked.at(-1)!.message).not.toContain('Messages since you last answered');
});
