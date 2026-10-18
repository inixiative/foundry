// Golden prompts and parses of a region Warden, recorded from the code before classify existed: every
// advice trigger, the guard, pre-start and review, each with the answers a Warden gives. With the
// default stages, classify must reproduce these bytes. Re-record only for an intended prompt change:
// CLASSIFY_GOLDEN=record bun test tests/classify-golden.test.ts, then `bunx biome check --write` the fixture.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type CompletionOpts,
  ContextLayer,
  type LLMMessage,
  type LLMProvider,
  SignalBus,
} from '@inixiative/foundry-core';
import { DomainLibrarian, type TurnActivity } from '../src/agents/domain-librarian';
import { regionInstructions } from '../src/agents/region-roster';

const GOLDEN = join(import.meta.dir, 'fixtures', 'classify', 'golden.json');
const RECORD = process.env.CLASSIFY_GOLDEN === 'record';

interface Call {
  messages: LLMMessage[];
  opts: Pick<CompletionOpts, 'stablePrefix' | 'threadPrefix' | 'priority' | 'timeout'>;
}

function warden(answer: string) {
  const calls: Call[] = [];
  const primes: Call[] = [];
  const llm: LLMProvider = {
    id: 'golden',
    async complete(messages, opts = {}) {
      calls.push({ messages: structuredClone(messages), opts: pick(opts) });
      return { content: answer, model: 'golden' };
    },
    prestart(messages, opts = {}) {
      primes.push({ messages: structuredClone(messages), opts: pick(opts) });
    },
  };
  const cache = new ContextLayer({ id: 'role:locks:domainKnowledge', segment: 'domain-knowledge' });
  cache.set(
    '# Locks\n\n- createLock (CONCURRENCY.md § Distributed Lock): exclusion across instances.\n- makeSerializedQueue (QUEUES.md § Serialized): ordering.',
  );
  const instructions = new ContextLayer({ id: 'role:locks:instructions' });
  instructions.set(
    regionInstructions({
      id: 'locks',
      title: 'Locks and serialization',
      routing: 'Is this about mutual exclusion or ordering?',
    }),
  );
  const lib = new DomainLibrarian({
    domain: 'locks',
    cache,
    instructions,
    role: 'locks',
    signals: new SignalBus(0),
    llm,
    guardTriggers: ['Write', 'Bash'],
  });
  return { lib, calls, primes };
}

function pick(opts: CompletionOpts): Call['opts'] {
  return {
    ...(opts.stablePrefix !== undefined ? { stablePrefix: opts.stablePrefix } : {}),
    ...(opts.threadPrefix !== undefined ? { threadPrefix: opts.threadPrefix } : {}),
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
  };
}

const RANKED = JSON.stringify({
  snippets: [
    'Look over here: createLock (CONCURRENCY.md § Distributed Lock) — exclusion across instances.',
    'Less likely: makeSerializedQueue (QUEUES.md § Serialized) — ordering, not exclusion.',
  ],
  layers: [],
  confidence: 0.8,
});
const CHOOSE_ONE = JSON.stringify({
  snippets: [
    'Choose one: Related systems; pick the one whose job matches.',
    'createLock (CONCURRENCY.md § Distributed Lock) — exclusion across instances.',
    'makeSerializedQueue (QUEUES.md § Serialized) — ordering.',
  ],
  layers: [],
  confidence: 0.6,
});
const CLASS = JSON.stringify({
  snippets: ['Look over here: the primitives listed under Locks (CONCURRENCY.md)'],
  layers: [],
  confidence: 0.4,
});
const ADVICE_ANSWERS = [
  'NO_COMMENT',
  '  NO_COMMENT\n',
  'NO_COMMENT.',
  'Nothing here. NO_COMMENT',
  RANKED,
  `\`\`\`json\n${RANKED}\n\`\`\``,
  CHOOSE_ONE,
  CLASS,
  'Look over here: createLock',
  JSON.stringify({ snippets: [], layers: [], confidence: 0 }),
  JSON.stringify({ snippets: ['x'], layers: [], confidence: 0.5, why: 'extra' }),
  JSON.stringify({ snippets: [''], layers: [], confidence: 0.5 }),
  '[]',
];

const finding = (description: string) => ({ severity: 'advisory', description });
const GUARD_ANSWERS = [
  'NO_COMMENT',
  JSON.stringify({
    findings: [
      {
        ...finding(
          'Look over here: createLock (CONCURRENCY.md § Distributed Lock) — the turn writes a SET NX lock.',
        ),
        location: 'call 1, src/jobs.ts',
      },
      finding('Less likely: makeSerializedQueue (QUEUES.md § Serialized) — ordering.'),
    ],
  }),
  JSON.stringify({
    findings: [
      finding('Choose one: Related systems; pick the one whose job matches.'),
      finding('createLock (CONCURRENCY.md) — exclusion.'),
      finding('makeSerializedQueue (QUEUES.md) — ordering.'),
    ],
  }),
  JSON.stringify({ findings: [] }),
  JSON.stringify({ findings: [{ severity: 'critical', description: 'x' }] }),
  JSON.stringify({ findings: [{ ...finding('x'), suggestion: 'do y' }] }),
  'NO_COMMENT please',
];

const ACTIVITY: TurnActivity = {
  turnId: 'turn-1',
  observations: [
    {
      tool: 'Write',
      input: { file_path: 'src/jobs.ts', content: 'redis.set(key, 1, "NX")' },
      callId: 'c1',
      ok: true,
      filesAffected: ['src/jobs.ts'],
    },
    { tool: 'Bash', input: { command: 'bun test' }, output: '3 pass', callId: 'c2', ok: false },
  ],
};

/** A result as the golden keeps it: what a caller reads, without capture times (the call holds the messages). */
function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) =>
      key === 'capturedAt' || key === 'composition' || key === 'messages' ? undefined : v,
    ),
  );
}

async function record() {
  const out: Record<string, unknown> = {};
  for (const trigger of ['user-message', 'consumed', 'subagent-spawn'] as const) {
    for (const [variant, thread] of [
      ['bare', {}],
      ['thread', { threadKnowledge: 'The thread is adding a nightly job.' }],
    ] as const) {
      const results = [];
      let call: Call | undefined;
      for (const answer of ADVICE_ANSWERS) {
        const { lib, calls } = warden(answer);
        const result = await lib.advise(
          'Add a job that must never run twice at once.',
          variant === 'thread' ? 'Thread state: one job queued.' : undefined,
          { ...thread, trigger, timeoutMs: 9_000 },
        );
        call ??= calls[0];
        results.push({ answer, result: stable(result) });
      }
      out[`advice:${trigger}:${variant}`] = { call, results };
    }
  }
  for (const [variant, opts] of [
    ['bare', {}],
    [
      'thread',
      { threadKnowledge: 'The thread is adding a nightly job.', threadKnowledgeRevision: 3 },
    ],
  ] as const) {
    const results = [];
    let call: Call | undefined;
    for (const answer of GUARD_ANSWERS) {
      const { lib, calls } = warden(answer);
      const result = await lib.guard(
        ACTIVITY,
        variant === 'thread' ? 'Thread state.' : undefined,
        opts,
      );
      call ??= calls[0];
      results.push({ answer, result: stable(result) });
    }
    out[`guard:${variant}`] = { call, results };
  }
  {
    const { lib, primes } = warden('NO_COMMENT');
    lib.prestart();
    out.prestart = primes;
  }
  {
    const { lib, calls } = warden('NO_COMMENT');
    await lib.review({
      evidence: { kind: 'dispatch', id: 'd1', timestamp: 1 },
      agentId: 'executor',
      userMessage: 'Add a job.',
      output: 'Added it.',
      ok: true,
      toolObservations: [],
    });
    out.review = calls[0];
  }
  return out;
}

test('a region Warden sends and reads exactly the golden prompts and parses', async () => {
  const now = await record();
  if (RECORD || !existsSync(GOLDEN)) {
    if (!RECORD) throw Error(`no golden at ${GOLDEN}: record it with CLASSIFY_GOLDEN=record`);
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(now).sort()).toEqual(Object.keys(golden).sort());
  for (const key of Object.keys(golden))
    expect({ [key]: now[key] }).toEqual({ [key]: golden[key] });
});
