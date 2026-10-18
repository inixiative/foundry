import { describe, expect, test } from 'bun:test';
import {
  type CompletionOpts,
  ContextLayer,
  type LLMMessage,
  type LLMProvider,
  SignalBus,
} from '@inixiative/foundry-core';
import { DomainLibrarian, type WardenStage } from '../src/agents/domain-librarian';
import {
  ADVICE_RESPONSE_PROTOCOL,
  adviceResponseProtocol,
  charterFor,
  DEFAULT_STAGE,
  EVAL_STAGE_KEYS,
  GUARD_RESPONSE_PROTOCOL,
  isDefaultStages,
  parseWardenPointer,
  pointCharter,
  RECOGNISE_CHARTER,
  readStageAnswer,
  responseProtocol,
  runStages,
  type StageConfig,
  validateStages,
  WARDEN_CHARTER,
} from '../src/classify';

const RANKED = 'Look over here: createLock (CONCURRENCY.md § Distributed Lock) — exclusion.';
const CHOOSE = [
  'Choose one: Related systems; pick the one whose job matches.',
  'createLock (CONCURRENCY.md) — exclusion.',
  'makeSerializedQueue (QUEUES.md) — ordering.',
];
const ALL = [
  'All of these: Each applies; read every one.',
  'auditLog (AUDIT.md § Audit) — the new table is audited.',
  'softDelete (DATA.md § Soft delete) — audited rows are soft-deleted.',
];
const advice = (snippets: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, snippets, layers: [], confidence: 0.7 });

describe('stage settings', () => {
  test('omitted fields take the default stage, which is today’s Warden', () => {
    const [stage] = validateStages('s', [{}]);
    expect(stage).toEqual(DEFAULT_STAGE);
    expect(isDefaultStages([stage!])).toBe(true);
    expect(isDefaultStages(validateStages('s', [{ reason: 'inline' }]))).toBe(false);
  });

  test('refuses, by name, what does not fit', () => {
    const refused: Array<[unknown, RegExp]> = [
      [[], /non-empty list/],
      [[{}, {}, {}, {}].map((s, i) => (i < 3 ? { ...s, escalate: ['yes'] } : s)), /at most 3/],
      [
        [{ sections: { job: false } }],
        /sections is not a setting: charters are fixed per task and role/,
      ],
      [[{ charter: 'x' }], /charter is not a setting: charters are fixed per task and role/],
      [[{ colour: 'x' }], /colour is not a stage setting/],
      [[{ task: 'recognise', pointer: { any: true } }], /pointer is for point stages/],
      [[{ pointer: { all: false } }], /"one" and "all" are always allowed; only "any" is a toggle/],
      [[{ escalate: ['yes'] }], /the last stage has no next stage/],
      [[{}, {}], /\[0\]\.escalate is required/],
      [[{ escalate: ['unsure'] }, {}], /only a ternary stage answers/],
      [[{ doc: '../secret.md' }], /doc must be a markdown file name/],
      [[{ effort: 'huge' }], /effort must be one of low, medium, high, xhigh, max/],
      [[{ escalate: ['yes'], deadline: 0.7 }, { deadline: 0.6 }], /add up to 1.3/],
    ];
    for (const [value, error] of refused) expect(() => validateStages('s', value)).toThrow(error);
    // A run config may set a stage's sections (eval only).
    expect(validateStages('run', [{ sections: { job: false } }], EVAL_STAGE_KEYS)).toHaveLength(1);
  });
});

describe('protocols', () => {
  test('the default stage’s protocol is exactly today’s advice and guard protocol', () => {
    for (const trigger of ['user-message', 'consumed', 'subagent-spawn'] as const)
      expect(
        responseProtocol({
          envelope: 'advice',
          trigger,
          task: 'point',
          outcomes: 'binary',
          reason: 'none',
        }),
      ).toBe(adviceResponseProtocol(trigger));
    expect(
      responseProtocol({
        envelope: 'guard',
        trigger: 'agent-action',
        task: 'point',
        outcomes: 'binary',
        reason: 'followup',
      }),
    ).toBe(GUARD_RESPONSE_PROTOCOL);
  });

  test('ternary reads YES, UNSURE and NO_COMMENT; anything else is malformed, never guessed', () => {
    const spec = {
      envelope: 'advice',
      trigger: 'user-message',
      task: 'point',
      outcomes: 'ternary',
      reason: 'none',
    } as const;
    const protocol = responseProtocol(spec);
    expect(protocol).toContain('"outcome": "yes" | "unsure"');
    expect(protocol).toContain('NO_COMMENT');
    expect(readStageAnswer('NO_COMMENT', spec)).toMatchObject({ outcome: 'no', remarks: [] });
    expect(readStageAnswer(advice([RANKED], { outcome: 'yes' }), spec)).toMatchObject({
      outcome: 'yes',
      pointer: { shape: 'ranked', pointer: 'createLock' },
    });
    expect(readStageAnswer(advice([RANKED], { outcome: 'unsure' }), spec)).toMatchObject({
      outcome: 'unsure',
    });
    expect(readStageAnswer(advice([RANKED]), spec)).toEqual({
      error: 'advice answer requires "outcome": "yes" | "unsure"',
    });
    expect(readStageAnswer(advice([RANKED], { outcome: 'maybe' }), spec)).toHaveProperty('error');
    // A binary stage has no unsure.
    expect(
      readStageAnswer(advice([RANKED], { outcome: 'unsure' }), { ...spec, outcomes: 'binary' }),
    ).toEqual({ error: 'advice response has 1 field(s) outside the protocol' });
  });

  test('a ternary recogniser tags each region line', () => {
    const spec = {
      envelope: 'advice',
      trigger: 'user-message',
      task: 'recognise',
      outcomes: 'ternary',
      reason: 'none',
    } as const;
    expect(responseProtocol(spec)).toContain('`<region id>: UNSURE — ');
    expect(
      readStageAnswer(
        advice(['locks: UNSURE — a job that must not overlap', 'queues: YES — ordering']),
        spec,
      ),
    ).toMatchObject({
      outcome: 'yes',
      regions: [
        { regionId: 'locks', outcome: 'unsure', why: 'a job that must not overlap' },
        { regionId: 'queues', outcome: 'yes', why: 'ordering' },
      ],
    });
    expect(readStageAnswer(advice(['locks: a job']), spec)).toEqual({
      error: 'recogniser answer has 1 line(s) in no shape (<region id>: <why>)',
    });
  });

  test('reason inline gives the why with every decision, the no included', () => {
    const spec = {
      envelope: 'guard',
      trigger: 'agent-action',
      task: 'point',
      outcomes: 'binary',
      reason: 'inline',
    } as const;
    const protocol = responseProtocol(spec);
    expect(protocol).toContain('"outcome": "no" | "yes", "why": string, "findings"');
    expect(protocol).toContain('answer "outcome": "no" instead');
    expect(
      readStageAnswer(JSON.stringify({ outcome: 'no', why: 'a test run', findings: [] }), spec),
    ).toEqual({ outcome: 'no', why: 'a test run', remarks: [], findings: [] });
    const yes = readStageAnswer(
      JSON.stringify({
        outcome: 'yes',
        why: 'it writes a lock',
        findings: [{ severity: 'advisory', description: RANKED }],
      }),
      spec,
    );
    expect(yes).toMatchObject({
      outcome: 'yes',
      why: 'it writes a lock',
      pointer: { pointer: 'createLock' },
    });
    expect(readStageAnswer('NO_COMMENT', spec)).toEqual({
      error: 'guard answer must be JSON with "outcome": "no", not NO_COMMENT',
    });
    expect(
      readStageAnswer(
        JSON.stringify({ outcome: 'yes', findings: [{ severity: 'advisory', description: 'x' }] }),
        spec,
      ),
    ).toEqual({ error: 'guard answer requires "why": non-empty string' });
    expect(
      readStageAnswer(
        JSON.stringify({
          outcome: 'no',
          why: 'x',
          findings: [{ severity: 'advisory', description: 'x' }],
        }),
        spec,
      ),
    ).toEqual({ error: 'guard answer "outcome": "no" must carry empty lists and nothing else' });
  });
});

describe('pointer shapes', () => {
  test('one and all are always offered; any (choose one) is a toggle of the charter and the parser', () => {
    expect(WARDEN_CHARTER).toBe(pointCharter({ any: true }));
    expect(WARDEN_CHARTER).toContain('**All of these**');
    expect(WARDEN_CHARTER).toContain('**Choose one**');
    const off = pointCharter({ any: false });
    expect(off).toContain('**All of these**');
    expect(off).toContain('**Ranked**');
    expect(off).not.toContain('Choose one');
    expect(charterFor('point', 'warden', { any: false }).version).not.toBe(
      charterFor('point', 'warden').version,
    );
    expect(charterFor('recognise', 'warden').text).toBe(RECOGNISE_CHARTER);
    expect(() => charterFor('point', 'herald')).toThrow(/Heralds are not built/);

    expect(parseWardenPointer(ALL)).toEqual({
      relevant: true,
      shape: 'all',
      pointer: 'auditLog, softDelete',
      level: 'exact',
      candidates: [
        { name: 'auditLog', where: 'AUDIT.md § Audit', note: 'the new table is audited.' },
        {
          name: 'softDelete',
          where: 'DATA.md § Soft delete',
          note: 'audited rows are soft-deleted.',
        },
      ],
    });
    const spec = {
      envelope: 'advice',
      trigger: 'user-message',
      task: 'point',
      outcomes: 'binary',
      reason: 'none',
    } as const;
    expect(readStageAnswer(advice(CHOOSE), spec, { any: true })).toMatchObject({
      pointer: { shape: 'choose-one', level: 'candidates' },
    });
    expect(readStageAnswer(advice(CHOOSE), spec, { any: false })).toEqual({
      error: 'a choose-one set is not offered at this stage (pointer.any is off)',
    });
    expect(readStageAnswer(advice(ALL), spec, { any: false })).toMatchObject({
      pointer: { shape: 'all' },
    });
    // The recognise charter never restates the protocol's shape.
    expect(RECOGNISE_CHARTER).not.toContain('JSON');
    expect(RECOGNISE_CHARTER).not.toContain('UNSURE');
  });
});

/** A provider answering from a script, recording each call's messages and options. */
function scripted(id: string, answers: Array<string | (() => Promise<string>)>) {
  const calls: Array<{ messages: LLMMessage[]; opts: CompletionOpts }> = [];
  const llm: LLMProvider = {
    id,
    async complete(messages, opts = {}) {
      calls.push({ messages: structuredClone(messages), opts });
      const next = answers.shift() ?? 'NO_COMMENT';
      return { content: typeof next === 'string' ? next : await next(), model: id };
    },
  };
  return { llm, calls };
}

function layer(id: string, text: string) {
  const l = new ContextLayer({ id, segment: 'domain-knowledge' });
  l.set(text);
  return l;
}

function twoStage(
  first: Partial<StageConfig>,
  second: Partial<StageConfig>,
  answers: {
    one: Array<string | (() => Promise<string>)>;
    two: Array<string | (() => Promise<string>)>;
  },
) {
  const [s1, s2] = validateStages('test', [first, second]);
  const one = scripted('haiku', answers.one);
  const two = scripted('sonnet', answers.two);
  const stages: WardenStage[] = [
    { config: s1!, cache: layer('recognise', '# Locks\nMutual exclusion across instances.') },
    {
      config: s2!,
      llm: two.llm,
      cache: layer('knowledge', '# Locks\n- createLock (CONCURRENCY.md)'),
    },
  ];
  const lib = new DomainLibrarian({
    domain: 'locks',
    cache: stages[0]!.cache!,
    signals: new SignalBus(0),
    llm: one.llm,
    stages,
    guardTriggers: ['Write'],
  });
  return { lib, one, two };
}

describe('the stage loop', () => {
  const recognise = {
    task: 'recognise',
    doc: 'recognise.md',
    outcomes: 'ternary',
    escalate: ['yes', 'unsure'],
  } as const;

  test('an UNSURE escalates with its tag, and the next stage’s input carries it', async () => {
    const { lib, one, two } = twoStage(
      recognise,
      {},
      {
        one: [advice(['locks: UNSURE — a nightly job that must not overlap'])],
        two: [advice([RANKED])],
      },
    );
    const result = await lib.advise('Add a nightly job that must never run twice.');
    expect(one.calls[0]!.messages[0]!.content).toStartWith(RECOGNISE_CHARTER);
    expect(one.calls[0]!.messages[1]!.content).toContain('Mutual exclusion across instances.');
    const second = two.calls[0]!.messages;
    expect(second[0]!.content).toStartWith(WARDEN_CHARTER);
    expect(second[1]!.content).toContain('- createLock (CONCURRENCY.md)');
    expect(second[1]!.content).toContain(
      '## An earlier stage\nStage 1 (haiku) was unsure this moment is in your region: a nightly job that must not overlap\nTreat that as no until your own knowledge shows otherwise.',
    );
    expect(second[1]!.content).toEndWith(ADVICE_RESPONSE_PROTOCOL);
    expect(result).toMatchObject({ snippets: [RANKED], pointer: { pointer: 'createLock' } });
    expect(result.classified).toMatchObject({
      outcome: 'yes',
      finalStage: 1,
      delivered: true,
      stages: [
        { stage: 0, task: 'recognise', doc: 'recognise.md', outcome: 'unsure', model: 'haiku' },
        { stage: 1, task: 'point', doc: 'knowledge.md', outcome: 'yes', model: 'sonnet' },
      ],
    });
  });

  test('a no stops the run; an outcome it does not escalate stops it too', async () => {
    const quiet = twoStage(recognise, {}, { one: ['NO_COMMENT'], two: [] });
    expect(await quiet.lib.advise('Rename a variable.')).toMatchObject({ noComment: true });
    expect(quiet.two.calls).toHaveLength(0);
    const held = twoStage(
      { ...recognise, escalate: ['yes'] },
      {},
      {
        one: [advice(['locks: UNSURE — maybe'])],
        two: [],
      },
    );
    const result = await held.lib.advise('Something vague.');
    // A final unsure is delivered as nothing, and journalled.
    expect(result).toMatchObject({
      noComment: true,
      classified: { outcome: 'unsure', delivered: false },
    });
    expect(held.two.calls).toHaveLength(0);
  });

  test('a later stage that outlives its share of the deadline leaves the previous outcome, journalled', async () => {
    const { lib, two } = twoStage(
      { escalate: ['yes'], deadline: 0.5 },
      { deadline: 0.5 },
      {
        one: [advice([RANKED])],
        two: [() => new Promise((resolve) => setTimeout(() => resolve('NO_COMMENT'), 500))],
      },
    );
    const result = await lib.advise('Add a lock.', undefined, { timeoutMs: 200 });
    // The last stage gets what the run has left: 200 ms less stage 1's time and the margin.
    expect(two.calls[0]!.opts.timeout).toBeGreaterThan(100);
    expect(two.calls[0]!.opts.timeout).toBeLessThanOrEqual(190);
    // Stage 1 pointed: its pointer stands and reaches the thread.
    expect(result).toMatchObject({ snippets: [RANKED], pointer: { pointer: 'createLock' } });
    expect(result.classified).toMatchObject({
      fallback: 'timeout',
      finalStage: 0,
      delivered: true,
      stages: [
        { stage: 0, outcome: 'yes' },
        { stage: 1, timedOut: true },
      ],
    });
  });

  test('a malformed later answer is counted and the previous outcome stands; a recogniser’s yes alone reaches nothing', async () => {
    const { lib } = twoStage(
      recognise,
      {},
      {
        one: [advice(['locks: YES — a lock'])],
        two: ['Look over here: createLock'],
      },
    );
    const result = await lib.advise('Add a lock.');
    expect(result).toMatchObject({
      noComment: true,
      classified: { outcome: 'yes', fallback: 'malformed', delivered: false },
    });
    expect(result.classified!.stages[1]).toMatchObject({
      malformed: true,
      error: expect.stringContaining('neither NO_COMMENT'),
    });
  });

  test('the guard runs the same stages over the agent’s actions, in the guard envelope', async () => {
    const { lib, one, two } = twoStage(
      recognise,
      {},
      {
        one: [
          JSON.stringify({
            findings: [{ severity: 'advisory', description: 'locks: YES — writes SET NX' }],
          }),
        ],
        two: [JSON.stringify({ findings: [{ severity: 'advisory', description: RANKED }] })],
      },
    );
    const result = await lib.guard({
      turnId: 't',
      observations: [{ tool: 'Write', input: { content: 'redis.set(k, 1, "NX")' } }],
    });
    expect(one.calls[0]!.messages[1]!.content).toContain(
      '## Response protocol (guard phase, trigger: agent-action)',
    );
    expect(two.calls[0]!.messages[1]!.content).toEndWith(GUARD_RESPONSE_PROTOCOL);
    expect(result).toMatchObject({
      status: 'completed',
      findings: [{ description: RANKED, pointer: { pointer: 'createLock' } }],
      classified: { outcome: 'yes', finalStage: 1 },
    });
  });

  test('reason followup asks why after the answer; the answer stands', async () => {
    const { llm, calls } = scripted('haiku', [
      'NO_COMMENT',
      'It asks for a rename.\nNothing in locks.\nREVISED: KEEP',
    ]);
    const lib = new DomainLibrarian({
      domain: 'locks',
      cache: layer('k', '# Locks'),
      signals: new SignalBus(0),
      llm,
      stages: [{ config: validateStages('s', [{ reason: 'followup' }])[0]! }],
    });
    const result = await lib.advise('Rename a variable.');
    expect(calls[1]!.messages.at(-2)).toEqual({ role: 'assistant', content: 'NO_COMMENT' });
    expect(calls[1]!.messages.at(-1)!.content).toContain('REVISED: KEEP');
    expect(result).toMatchObject({
      noComment: true,
      classified: {
        outcome: 'no',
        stages: [
          { outcome: 'no', why: 'It asks for a rename. Nothing in locks.', revised: 'keep' },
        ],
      },
    });
  });

  test('a recogniser that names only regions it does not hold is malformed; a fan-out starts past it', async () => {
    const [s1, s2] = validateStages('s', [recognise, {}]);
    const asked: number[] = [];
    const unknown = await runStages({
      stages: [s1!, s2!],
      envelope: 'advice',
      trigger: 'user-message',
      holds: ['locks'],
      ask: async (run) => {
        asked.push(run.index);
        return { content: advice(['queues: YES — ordering']) };
      },
    });
    expect(unknown).toMatchObject({ malformed: true, delivered: false });
    expect(unknown.stages[0]).toMatchObject({ unknownRegions: ['queues'] });
    const fanned = await runStages({
      stages: [s1!, s2!],
      envelope: 'advice',
      trigger: 'user-message',
      from: { index: 1, carried: { stage: 0, outcome: 'yes', why: 'ordering' } },
      ask: async (run) => {
        asked.push(run.index);
        expect(run.carried).toEqual({ stage: 0, outcome: 'yes', why: 'ordering' });
        return { content: advice([RANKED]) };
      },
    });
    expect(asked).toEqual([0, 1]);
    expect(fanned).toMatchObject({ outcome: 'yes', finalStage: 1, delivered: true });
  });
});
