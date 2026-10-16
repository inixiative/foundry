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
    expect(none.usage).toMatchObject({ input: 13, output: 7, cacheRead: 100, total: 120 });
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
      windows: { five_hour: 10, seven_day: 4 },
      attribution: run('none'),
      timestamp: 1,
    });
    tracker.recordWindows({
      provider: 'claude-code',
      integrationId: login,
      phase: 'after',
      source: 'session',
      windows: { five_hour: 12.5, seven_day: 4.25, opus: 1 },
      plan: 'max',
      attribution: run('none'),
    });
    tracker.recordWindows({
      provider: 'claude-code',
      integrationId: 'setup-token:other',
      phase: 'before',
      source: 'probe',
      windows: { five_hour: 50 },
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

  test('windowDelta covers ids present in both readings', () => {
    expect(windowDelta({ five_hour: 10, seven_day: 4 }, { five_hour: 12.5, opus: 1 })).toEqual({
      five_hour: 2.5,
    });
    expect(windowDelta({ a: 0.1 }, { a: 0.3 })).toEqual({ a: 0.2 });
  });
});
