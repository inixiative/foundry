import { expect, test } from 'bun:test';
import {
  parseWardenJudgement,
  scoreCharterRun,
  type WardenProbe,
  type WardenProbeAnswer,
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
