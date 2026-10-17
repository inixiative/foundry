import { expect, test } from 'bun:test';
import { ContextLayer, type LLMProvider, SignalBus } from '@inixiative/foundry-core';
import {
  adviceResponseProtocol,
  DomainLibrarian,
  GUARD_RESPONSE_PROTOCOL,
  oneCall,
  validateGuardResponse,
} from '../src/agents/domain-librarian';
import {
  CHOOSE_ONE_CAVEAT,
  MAX_POINTER_NAMES,
  parseWardenPointer,
} from '../src/agents/warden-charter';

// The classifier contract (Aron, 2026-10-17): a Warden judges only relevance and likelihood. Its
// remarks are a ranked pointer, a choose-one sibling set, or a class, at most three names, each with
// where it is written and one line that tells it apart. Nothing it returns says whether to use anything.

const LOCK =
  'Look over here: createLock (CONCURRENCY.md § Distributed Lock) — exclusion across instances.';
const QUEUE =
  'Less likely: makeSerializedQueue (QUEUES.md § Serialized) — ordering, not exclusion.';
const ROW =
  'Less likely: db.findForUpdate (CONCURRENCY.md § Row locks) — one row, inside a transaction.';

test('a ranked pointer: the top name with its why, then the less likely ones with what tells them apart', () => {
  expect(parseWardenPointer([LOCK, QUEUE, ROW])).toEqual({
    relevant: true,
    shape: 'ranked',
    pointer: 'createLock',
    where: 'CONCURRENCY.md § Distributed Lock',
    why: 'exclusion across instances.',
    level: 'exact',
    candidates: [
      {
        name: 'makeSerializedQueue',
        where: 'QUEUES.md § Serialized',
        note: 'ordering, not exclusion.',
      },
      {
        name: 'db.findForUpdate',
        where: 'CONCURRENCY.md § Row locks',
        note: 'one row, inside a transaction.',
      },
    ],
  });
  // A name past three is counted, never kept or silently dropped; so is a remark that fits no line.
  const over = parseWardenPointer([
    LOCK,
    QUEUE,
    ROW,
    'Less likely: claimLane (LANES.md) — supersede.',
  ]);
  expect(over.candidates).toHaveLength(MAX_POINTER_NAMES - 1);
  expect(over.unparsed).toBe(1);
  expect(parseWardenPointer([LOCK, 'Use it instead of SET NX.']).unparsed).toBe(1);
  // "Less likely" before the top line: the shape opens at the first pointer line, the stray is counted.
  expect(parseWardenPointer([QUEUE, LOCK])).toMatchObject({ pointer: 'createLock', unparsed: 1 });
  // Parentheses inside the location, a dash in the name's note, a hyphen as the separator.
  expect(
    parseWardenPointer(
      'Look over here: claimLane (CONCURRENCY.md, Supersede Lanes (claimLane / watchLane)) - latest wins',
    ),
  ).toMatchObject({
    pointer: 'claimLane',
    where: 'CONCURRENCY.md, Supersede Lanes (claimLane / watchLane)',
    why: 'latest wins',
  });
  // A name written as a call keeps its parentheses; the location is the next group.
  expect(
    parseWardenPointer('Look over here: db.findForUpdate() (DATABASE.md § Row Locks) — one row'),
  ).toMatchObject({
    pointer: 'db.findForUpdate()',
    where: 'DATABASE.md § Row Locks',
    why: 'one row',
  });
  expect(parseWardenPointer('Look over here: createLock — exclusion')).toMatchObject({
    pointer: 'createLock',
    why: 'exclusion',
  });
});

test('a choose-one set: the fixed caveat, then each sibling with its distinction, on the candidates rung', () => {
  const set = [
    `Choose one: ${CHOOSE_ONE_CAVEAT}`,
    'createLock (CONCURRENCY.md § Distributed Lock) — exclusion across instances',
    'makeSerializedQueue (QUEUES.md § Serialized) — ordering of jobs',
    'db.findForUpdate (CONCURRENCY.md § Row locks) — one row in a transaction',
  ];
  expect(parseWardenPointer(set)).toEqual({
    relevant: true,
    shape: 'choose-one',
    pointer: 'createLock, makeSerializedQueue, db.findForUpdate',
    level: 'candidates',
    candidates: [
      {
        name: 'createLock',
        where: 'CONCURRENCY.md § Distributed Lock',
        note: 'exclusion across instances',
      },
      { name: 'makeSerializedQueue', where: 'QUEUES.md § Serialized', note: 'ordering of jobs' },
      {
        name: 'db.findForUpdate',
        where: 'CONCURRENCY.md § Row locks',
        note: 'one row in a transaction',
      },
    ],
  });
  // Capped at three, the excess counted; a header with no members is relevant with no level.
  const four = parseWardenPointer([...set, 'claimLane (LANES.md) — latest wins']);
  expect(four.candidates).toHaveLength(3);
  expect(four.unparsed).toBe(1);
  expect(parseWardenPointer(`Choose one: ${CHOOSE_ONE_CAVEAT}`)).toEqual({
    relevant: true,
    shape: 'choose-one',
    candidates: [],
  });
});

test('the class rung and non-pointers', () => {
  expect(
    parseWardenPointer('Look over here: the primitives listed under locks (CONCURRENCY.md)'),
  ).toMatchObject({ shape: 'ranked', level: 'class' });
  expect(parseWardenPointer('Use createLock instead of SET NX.')).toEqual({ relevant: false });
  expect(parseWardenPointer([])).toEqual({ relevant: false });
});

test('no field of the parsed pointer, and no field the guard protocol offers, is a verdict', () => {
  const fields = new Set<string>();
  for (const remarks of [
    [LOCK, QUEUE],
    [`Choose one: ${CHOOSE_ONE_CAVEAT}`, 'a (x) — y', 'b (z) — w'],
  ])
    for (const key of Object.keys(parseWardenPointer(remarks))) fields.add(key);
  expect([...fields].sort()).toEqual(
    ['candidates', 'level', 'pointer', 'relevant', 'shape', 'where', 'why'].sort(),
  );
  // The guard protocol: advisory only, no suggested fix, no "violation" framing.
  expect(GUARD_RESPONSE_PROTOCOL).toContain('"severity": "advisory"');
  expect(GUARD_RESPONSE_PROTOCOL).not.toContain('critical');
  expect(GUARD_RESPONSE_PROTOCOL).not.toContain('suggestion');
  expect(GUARD_RESPONSE_PROTOCOL).not.toContain('violation');
  const critical = JSON.stringify({ findings: [{ severity: 'critical', description: LOCK }] });
  const suggested = JSON.stringify({
    findings: [{ severity: 'advisory', description: LOCK, suggestion: 'use createLock' }],
  });
  expect(validateGuardResponse(critical)).toEqual({
    error: 'guard finding 0 requires "severity": "advisory"',
  });
  expect(validateGuardResponse(suggested)).toEqual({
    error: 'guard finding 0 has 1 field(s) outside the protocol',
  });
  // Every advice trigger has the one bar: touches nothing, whatever it says to build.
  for (const trigger of ['user-message', 'consumed', 'subagent-spawn'] as const) {
    const protocol = adviceResponseProtocol(trigger);
    expect(protocol).toContain(`trigger: ${trigger})`);
    expect(protocol).toContain('whatever it says to build or not to use');
    expect(protocol).not.toContain('would otherwise have to say themselves');
    expect(protocol).not.toContain('already carries what your domain would add');
  }
});

test('a Warden reads its pointer over all its remarks, in advice and in guard', async () => {
  const answers = { advice: '', guard: '' };
  const seen: string[] = [];
  const llm: LLMProvider = {
    id: 'w',
    async complete(messages) {
      const text = messages.map((m) => m.content).join('\n');
      seen.push(text);
      return { model: 'x', content: text.includes('guard phase') ? answers.guard : answers.advice };
    },
  };
  const cache = new ContextLayer({ id: 'k' });
  cache.set('KNOWLEDGE');
  const warden = new DomainLibrarian({
    domain: 'concurrency-locks',
    cache,
    signals: new SignalBus(0),
    llm,
    guardTriggers: ['Write'],
  });
  answers.advice = JSON.stringify({ snippets: [LOCK, QUEUE], layers: [], confidence: 0.8 });
  expect((await warden.advise("Add a new lock table; don't use createLock")).pointer).toMatchObject(
    {
      shape: 'ranked',
      pointer: 'createLock',
      candidates: [{ name: 'makeSerializedQueue' }],
    },
  );
  answers.guard = JSON.stringify({
    findings: [
      { severity: 'advisory', description: `Choose one: ${CHOOSE_ONE_CAVEAT}` },
      { severity: 'advisory', description: 'createLock (CONCURRENCY.md) — exclusion' },
      { severity: 'advisory', description: 'makeSerializedQueue (QUEUES.md) — ordering' },
    ],
  });
  const guarded = await warden.guard(oneCall({ tool: 'Write', input: { text: 'SET NX' } }));
  expect(guarded.status).toBe('completed');
  expect(guarded.findings[0]!.pointer).toMatchObject({ shape: 'choose-one', level: 'candidates' });
  expect(guarded.findings[1]!.pointer).toBeUndefined();
  expect(seen.at(-1)).toContain(GUARD_RESPONSE_PROTOCOL);
  // A verdict-shaped guard answer is an invalid response, never a completed check.
  answers.guard = JSON.stringify({ findings: [{ severity: 'critical', description: LOCK }] });
  expect((await warden.guard(oneCall({ tool: 'Write', input: {} }))).status).toBe(
    'invalid-response',
  );
});
