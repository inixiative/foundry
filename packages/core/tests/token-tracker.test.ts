import { describe, expect, test } from 'bun:test';
import { TokenTracker, windowDelta } from '../src/token-tracker';

const run = (arm: string) => ({ fixtureId: '695', arm, runId: `run-${arm}`, role: 'implementer' });

describe('usage attribution', () => {
  test('entries carry effort, login and attribution, and filters select on every key', () => {
    const tracker = new TokenTracker();
    tracker.record({
      provider: 'claude-code',
      model: 'claude-opus-5-5',
      effort: 'high',
      integrationId: 'setup-token:abc123',
      attribution: run('none'),
      tokens: { input: 10, output: 5, cacheRead: 100 },
    });
    tracker.record({
      provider: 'claude-code',
      model: 'claude-opus-5-5',
      effort: 'high',
      integrationId: 'setup-token:abc123',
      attribution: run('none'),
      tokens: { input: 3, output: 2 },
    });
    tracker.record({
      provider: 'claude-code',
      model: 'claude-opus-5-5',
      effort: 'low',
      integrationId: 'setup-token:def456',
      attribution: run('correction'),
      tokens: { input: 7, output: 1 },
    });

    const none = tracker.usageRecord({ attribution: { fixtureId: '695', arm: 'none' } });
    expect(none.calls).toBe(2);
    expect(none.totals).toMatchObject({ input: 13, output: 7, cacheRead: 100, total: 120 });
    expect(none.entries.every((e) => e.attribution?.arm === 'none')).toBe(true);

    expect(tracker.entries({ integrationId: 'setup-token:def456' })).toHaveLength(1);
    expect(tracker.entries({ effort: 'high' })).toHaveLength(2);
    expect(tracker.entries({ attribution: { role: 'subject' } })).toHaveLength(0);
    expect(tracker.entries()).toHaveLength(3);
  });

  test('window readings are recorded per login, selected by attribution, and cost nothing', () => {
    const tracker = new TokenTracker({ budget: { maxTokens: 1 } });
    const login = 'setup-token:abc123';
    tracker.recordWindows({
      provider: 'claude-code',
      integrationId: login,
      phase: 'before',
      source: 'session',
      windows: { five_hour: { usedPercent: 10 }, seven_day: { usedPercent: 4 } },
      attribution: run('none'),
      timestamp: 1,
    });
    tracker.recordWindows({
      provider: 'claude-code',
      integrationId: login,
      phase: 'after',
      source: 'session',
      windows: {
        five_hour: { usedPercent: 12.5 },
        seven_day: { usedPercent: 4.25 },
        opus: { usedPercent: 1 },
      },
      blocked: false,
      plan: 'max',
      attribution: run('none'),
    });
    tracker.recordWindows({
      provider: 'claude-code',
      integrationId: 'setup-token:other',
      phase: 'before',
      source: 'probe',
      windows: { five_hour: { usedPercent: 50 } },
      attribution: run('correction'),
    });
    const record = tracker.usageRecord({ attribution: { arm: 'none' } });
    expect(record.calls).toBe(0);
    expect(record.windowReadings.map((r) => r.phase)).toEqual(['before', 'after']);
    expect(record.windowReadings[0]?.timestamp).toBe(1);
    // A model filter does not drop readings: they carry no model.
    expect(tracker.windowReadings({ model: 'x', integrationId: login })).toHaveLength(2);
    expect(tracker.budgetStatus.usedTokens).toBe(0);
    tracker.reset();
    expect(tracker.windowReadings()).toHaveLength(0);
  });

  test('windowDelta covers ids present in both readings, and sets aside a window that reset', () => {
    const w = (usedPercent: number, resetsAt?: number) => ({ usedPercent, resetsAt });
    expect(
      windowDelta({ five_hour: w(10), seven_day: w(4) }, { five_hour: w(12.5), opus: w(1) }),
    ).toEqual({
      delta: { five_hour: 2.5 },
      reset: [],
    });
    expect(windowDelta({ a: w(0.1) }, { a: w(0.3) }).delta).toEqual({ a: 0.2 });
    const hour = 3_600_000;
    expect(
      windowDelta(
        { five_hour: w(90, 5 * hour), seven_day: w(40, 100 * hour) },
        { five_hour: w(3, 10 * hour), seven_day: w(41, 100 * hour + 1_000) },
      ),
    ).toEqual({ delta: { seven_day: 1 }, reset: ['five_hour'] });
  });
});
