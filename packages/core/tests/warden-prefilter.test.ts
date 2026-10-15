import { expect, test } from 'bun:test';
import {
  type PrefilterPair,
  prefilterConsistency,
  prefilterDescription,
  prefilterSkips,
  prefilterState,
  scorePrefilter,
} from '../src/feedback/warden-prefilter';

const pair = (score: number | undefined, relevant?: boolean) =>
  ({
    momentId: 'm',
    wardenId: 'w',
    ...(relevant === undefined ? {} : { relevant }),
    ...(score === undefined ? {} : { score }),
  }) as PrefilterPair;

test('fails open: no score or an unsure score asks the Warden; only a confident no skips', () => {
  expect(prefilterSkips(undefined, 0.5)).toBe(false);
  expect(prefilterSkips(0.6, 0.5)).toBe(false);
  expect(prefilterSkips(0.1, 0.5)).toBe(true);
});

test('recall at a skip rate and skip rate at a recall read the same scores', () => {
  // 10 pairs: 4 relevant (0.9, 0.8, 0.4, 0.05), 2 labelled not relevant, 4 unlabelled (one failed).
  const pairs = [
    pair(0.9, true),
    pair(0.8, true),
    pair(0.4, true),
    pair(0.05, true),
    pair(0.01, false),
    pair(0.3, false),
    pair(0.02),
    pair(0.03),
    pair(0.04),
    pair(undefined),
  ];
  const score = scorePrefilter(pairs, { skipRates: [0.5], recalls: [0.75, 1] });
  expect(score.errors).toBe(1);
  // Skipping half: the threshold is 0.3, which skips 0.01–0.05, including the 0.05 positive.
  expect(score.recallAtSkip['0.5']).toBe(0.75);
  // Recall 0.75 allows one miss: threshold 0.4 skips the 0.05 positive and five others.
  expect(score.skipAtRecall['0.75']).toEqual({ threshold: 0.4, skipRate: 0.6 });
  expect(score.skipAtRecall['1']).toEqual({ threshold: 0.05, skipRate: 0.4 });
  expect(score.auroc).toBe(0.875);
  const half = score.sweep.find((p) => p.threshold === 0.5)!;
  expect(half.recall).toBe(0.5);
  expect(half.correctSkips).toBe(1);
});

test('consistency counts pairs whose decision never flipped', () => {
  const repeats = new Map<string, (number | undefined)[]>([
    ['a', [0.1, 0.12, 0.11]],
    ['b', [0.45, 0.55, 0.5]],
    ['c', [0.9, undefined, 0.9]],
  ]);
  expect(prefilterConsistency(repeats, 0.5)).toEqual({
    pairs: 3,
    sameDecision: 0.667,
    meanSpread: 0.04,
  });
});

test('the state and description stay inside the decision model window', () => {
  expect(prefilterDescription('x '.repeat(1000)).length).toBeLessThanOrEqual(480);
  const state = prefilterState('agent-action', `${'a'.repeat(3000)}END`, 'c'.repeat(1000));
  expect(state).toContain('END');
  expect(state.length).toBeLessThan(2100);
});

test('the description drops the Warden opener so the question reads as a topic', () => {
  expect(prefilterDescription('You are the Schema Warden. For Prisma schema, check things.')).toBe(
    'For Prisma schema, check things.',
  );
});
