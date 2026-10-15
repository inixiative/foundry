import { expect, test } from 'bun:test';
import {
  correctionTargetMessages,
  parseCorrectionTargets,
  parseTargetCanonical,
  parseWardenJudgement,
  parseWardenPointerJudgement,
  probeTriggers,
  scoreCharterRun,
  type WardenProbe,
  type WardenProbeAnswer,
  wardenJudgeMessage,
  wardenPointerJudgeMessage,
} from '../src/feedback/warden-probes';

const probes: WardenProbe[] = [
  {
    id: 'p1',
    kind: 'positive',
    ctx: 'x',
    moment: 'm',
    gold: { domains: ['schema'], statements: [] },
    hidden: 'h',
  },
  {
    id: 'p2',
    kind: 'positive',
    ctx: 'x',
    moment: 'm',
    gold: { domains: ['ship'], statements: [] },
    hidden: 'h',
  },
  { id: 'n1', kind: 'negative', ctx: 'x', moment: 'm' },
];
const said = (
  probeId: string,
  domain: string,
  matches: boolean,
  inDomain = true,
): WardenProbeAnswer => ({
  probeId,
  domain,
  noComment: false,
  text: 'remark',
  judged: { matches, inDomain },
});
const quiet = (probeId: string, domain: string): WardenProbeAnswer => ({
  probeId,
  domain,
  noComment: true,
});

test('silence, speech, scope and recall are scored against who owns the correction', () => {
  const score = scoreCharterRun(
    probes,
    [
      said('p1', 'schema', true), // the owner names the real correction: recall
      quiet('p1', 'ship'), // nothing of ship's applied: a correct silence
      said('p2', 'schema', true), // a non-owner matching does not count as recall, and is not a broken silence
      quiet('p2', 'ship'), // the owner stayed quiet: missed
      said('n1', 'schema', false, false), // noise, out of scope
      quiet('n1', 'ship'),
      {
        probeId: 'n1',
        domain: 'types',
        noComment: false,
        error: 'advice answer is neither NO_COMMENT nor a JSON object',
      },
    ],
    [
      { probeId: 'p1', calls: 2, wallMs: 100, notAdmitted: 0 },
      { probeId: 'n1', calls: 3, wallMs: 300, notAdmitted: 1 },
    ],
  );
  expect(score).toMatchObject({
    calls: 7,
    errors: 1,
    remarks: 3,
    silences: 3,
    unjudged: 0,
    scopeViolations: 1,
    speakPrecision: 0.667,
    recall: 0.5,
  });
  // Nothing applied: p1/ship (quiet), n1/schema (spoke), n1/ship (quiet), n1/types (error = failed silence).
  expect(score.silencePrecision).toBe(0.5);
  expect(score.turns).toEqual({
    count: 2,
    callsPerTurn: 2.5,
    p50Ms: 300,
    p95Ms: 300,
    maxMs: 300,
    notAdmitted: 1,
  });
});

test('anticipation counts any Warden at any trigger; wrong remarks are counted per trigger', () => {
  const asked: WardenProbe[] = [
    { id: 'a1', kind: 'positive', ctx: 'x', moment: '', ask: 'add retries', hidden: 'h' },
    { id: 'a2', kind: 'positive', ctx: 'x', moment: 'turn', ask: 'ship it', hidden: 'h' },
    { id: 'a3', kind: 'negative', ctx: 'x', moment: 'turn' },
  ];
  expect(probeTriggers(asked[0]!)).toEqual(['user-message']);
  expect(probeTriggers(asked[1]!)).toEqual(['user-message', 'agent-action']);
  expect(probeTriggers(asked[2]!)).toEqual(['agent-action']);
  const score = scoreCharterRun(asked, [
    { ...said('a1', 'reuse', true), trigger: 'user-message' }, // said first, before the agent worked
    { ...said('a2', 'ship', false), trigger: 'user-message' },
    { ...quiet('a2', 'ship'), trigger: 'agent-action' },
    { ...said('a3', 'lean', false), trigger: 'agent-action' },
  ]);
  expect(score).toMatchObject({
    anticipated: 0.5,
    recall: null, // no gold domains: owner recall does not apply
    wrongRemarks: 2,
    wrongPerProbe: 0.667,
  });
  expect(score.byTrigger['user-message']).toEqual({
    probes: 2,
    positives: 2,
    anticipated: 0.5,
    remarks: 2,
    speakPrecision: 0.5,
    wrongRemarks: 1,
  });
  expect(score.byTrigger['agent-action']).toMatchObject({
    probes: 2,
    positives: 1,
    anticipated: 0,
  });
});

test('the judge sees what the Warden saw at its trigger', () => {
  const before = wardenJudgeMessage({
    domain: 'reuse',
    domainDescription: 'd',
    moment: 'agent turn',
    ask: 'user ask',
    trigger: 'user-message',
    remark: 'r',
    hidden: 'h',
  });
  expect(before).toContain("## The user's message\n\nuser ask");
  expect(before).toContain('the Warden did not see it');
  const after = wardenJudgeMessage({
    domain: 'reuse',
    domainDescription: 'd',
    moment: 'agent turn',
    remark: 'r',
    hidden: '',
  });
  expect(after).toContain('## Agent turn\n\nagent turn');
  expect(after).toContain('without correcting it');
});

test('a judge answer parses strictly', () => {
  expect(parseWardenJudgement('{"matches":true,"inDomain":false,"reason":"same fix"}')).toEqual({
    matches: true,
    inDomain: false,
    reason: 'same fix',
  });
  expect(parseWardenJudgement('```json\n{"matches":false,"inDomain":true}\n```')).toEqual({
    matches: false,
    inDomain: true,
  });
  expect(parseWardenJudgement('Sure: {"matches":true,"inDomain":true}')).toBeUndefined();
  expect(parseWardenJudgement('{"matches":"yes","inDomain":true}')).toBeUndefined();
});

test('correction targets parse strictly: a thing, no existing thing, or unanswered', () => {
  const content = JSON.stringify({
    results: {
      a: {
        target: {
          name: 'Inquiry handler autoApprove',
          kind: 'system',
          concept: 'Requests / Inquiry',
        },
      },
      b: { target: null },
      c: { target: { kind: 'rule' } },
    },
  });
  expect(parseCorrectionTargets(`Here: ${content}`, ['a', 'b', 'c', 'd'])).toEqual([
    { name: 'Inquiry handler autoApprove', kind: 'system', concept: 'requests-inquiry' },
    null,
    undefined,
    undefined,
  ]);
  expect(parseCorrectionTargets('not json', ['a'])).toEqual([undefined]);
  const [, user] = correctionTargetMessages([
    { id: 'a', moment: '', ask: 'add a lock', hidden: 'use the lock helper' },
  ]);
  expect(user!.content).toContain('### Request\nadd a lock');
  expect(user!.content).toContain('concurrency-locking');
});

test('canonical names map in order, keeping a name the merge left out', () => {
  expect(
    parseTargetCanonical('{"canonical":{"N1":"shared VCR utilities"}}', [
      'vcr utils',
      'vcr wrapper',
    ]),
  ).toEqual(['shared VCR utilities', 'vcr wrapper']);
});

test('with a target, the judge is shown it', () => {
  const message = wardenJudgeMessage({
    domain: 'reuse',
    domainDescription: 'd',
    moment: 'turn',
    remark: 'r',
    hidden: 'h',
    target: {
      name: 'lock helper',
      kind: 'primitive',
      concept: 'concurrency-locking',
      canonical: 'SELECT FOR UPDATE lock helper',
    },
  });
  expect(message).toContain(
    '## TARGET (what the user pushed the agent toward)\n\nSELECT FOR UPDATE lock helper (primitive, concurrency-locking)',
  );
});

test('the pointer judge sees the moment, the target and where it is written, and parses the ladder strictly', () => {
  const message = wardenPointerJudgeMessage({
    moment: 'SET NX plus a setInterval renew',
    target: {
      name: 'createLock',
      kind: 'primitive',
      concept: 'concurrency-locking',
      where: '@template/db',
    },
    pointer: 'Look over here: createLock (docs/claude/CONCURRENCY.md)',
  });
  expect(message).toContain('createLock (primitive, @template/db)');
  expect(message).toContain('## Pointer');
  expect(parseWardenPointerJudgement('```json\n{"level":"candidates","reason":"r"}\n```')).toEqual({
    level: 'candidates',
    reason: 'r',
  });
  expect(parseWardenPointerJudgement('{"level":"close"}')).toBeUndefined();
  expect(parseWardenPointerJudgement('not json')).toBeUndefined();
});
