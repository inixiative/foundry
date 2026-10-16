import { describe, expect, test } from 'bun:test';
import { kindWeighted, modelWeighted, POINTS_PER_WEIGHTED_TOKEN } from './cost-weights';

const tokens = (
  o: Partial<Record<'input' | 'cacheRead' | 'cacheWrite' | 'output' | 'thinking', number>>,
) => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  thinking: 0,
  ...o,
});

describe('weighted cost', () => {
  test('weights by kind', () => {
    expect(
      kindWeighted(tokens({ input: 10, cacheRead: 1000, cacheWrite: 50, output: 20, thinking: 4 })),
    ).toBe(10 + 100 + 100 + 100 + 20);
  });
  test('a Sonnet token counts 9 Haiku tokens; stages sum', () => {
    const w = modelWeighted([
      { model: 'claude-haiku-5-5', tokens: tokens({ cacheRead: 10_000 }), calls: 2 },
      { model: 'claude-sonnet-5-5', tokens: tokens({ cacheRead: 10_000 }), calls: 1 },
    ]);
    expect(w.byModel.map((b) => b.weightedTokens)).toEqual([1_000, 9_000]);
    expect(w.total).toBe(10_000);
    expect(w.noModelWeight).toEqual([]);
  });
  test('a model with no pre-registered weight leaves the total empty', () => {
    const w = modelWeighted([{ model: 'claude-opus-5-5', tokens: tokens({ input: 5 }), calls: 1 }]);
    expect(w.total).toBeNull();
    expect(w.noModelWeight).toEqual(['claude-opus-5-5']);
  });
  test('the coefficient reproduces the after-run calibration', () => {
    expect(Math.round(224_661 * POINTS_PER_WEIGHTED_TOKEN * 100) / 100).toBe(0.11);
  });
});
