import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LimitSnapshot } from '@inixiative/agent-session';
import { defaultProfileSource } from '../src/providers/default-profiles';
import type { ProviderAccount } from '../src/providers/provider-accounts';
import { fetchLoginQuotaResetAt, providerLimits } from '../src/providers/provider-limits';

const account = (
  provider: string,
  source: ProviderAccount['source'],
  detail: string,
): ProviderAccount => ({
  provider,
  source,
  detail,
  ready: true,
  uses: ['main thread'],
});
const snapshot = (runtime: 'claude' | 'codex' | 'muse'): LimitSnapshot => ({
  runtime,
  source: 'poll',
  observedAt: 1,
  windows: [{ id: 'five_hour', usedPercent: 7, windowMinutes: 300 }],
});

test('each subscription login is probed in its own home; a Kingdom pool and API keys are not', async () => {
  const homes: Array<[string, Record<string, string> | undefined]> = [];
  const probes = {
    'claude-code': async (env: Record<string, string> | undefined) => {
      homes.push(['claude', env]);
      return snapshot('claude');
    },
    codex: async (env: Record<string, string> | undefined) => {
      homes.push(['codex', env]);
      return undefined;
    },
    muse: async (env: Record<string, string> | undefined) => {
      homes.push(['muse', env]);
      return snapshot('muse');
    },
  };
  const limits = await providerLimits(
    [
      account('claude-code', 'login', '/Users/me/.claude'),
      account('codex', 'profile', '/Users/me/.foundry/codex-work'),
      account('muse', 'login', '/Users/me/.config/muse'),
      account('gemini', 'api-key', 'GEMINI_API_KEY'),
    ],
    probes,
  );
  // The default login probes in the CLI's own home; a separate profile in its directory.
  expect(homes).toEqual([
    ['claude', undefined],
    ['codex', { CODEX_HOME: '/Users/me/.foundry/codex-work' }],
    ['muse', undefined],
  ]);
  expect(limits).toEqual([
    { provider: 'claude-code', state: 'probed', snapshot: snapshot('claude') },
    { provider: 'codex', state: 'unavailable' },
    { provider: 'muse', state: 'probed', snapshot: snapshot('muse') },
  ]);

  // A Kingdom pool's limits are Kingdom's; a fresh reading is reused, not probed again.
  homes.length = 0;
  const again = await providerLimits(
    [
      account('claude-code', 'login', '/Users/me/.claude'),
      account('codex', 'kingdom', 'https://kingdom'),
    ],
    probes,
  );
  expect(homes).toEqual([]);
  expect(again.map((l) => l.state)).toEqual(['probed', 'kingdom']);
});

describe('when a used-up login frees up', () => {
  const login = (name: string) => ({
    ...defaultProfileSource('claude'),
    profileDirectory: join(tmpdir(), `foundry-quota-${name}-${process.pid}`),
  });
  const reading = (blocked: boolean, windows: LimitSnapshot['windows']): LimitSnapshot => ({
    runtime: 'claude',
    source: 'poll',
    observedAt: 1,
    blocked,
    windows,
  });
  const probing = (...readings: Array<LimitSnapshot | undefined>) => {
    let calls = 0;
    const next = async () => readings[Math.min(calls++, readings.length - 1)];
    return { probes: { 'claude-code': next, codex: next, muse: next }, calls: () => calls };
  };

  test('used up: the latest reset among the windows at their limit', async () => {
    const { probes } = probing(
      reading(true, [
        { id: 'five_hour', usedPercent: 100, windowMinutes: 300, resetsAt: 5000 },
        { id: 'seven_day', usedPercent: 100, windowMinutes: 10080, resetsAt: 9000 },
        { id: 'opus', usedPercent: 40, windowMinutes: 10080, resetsAt: 20_000 },
      ]),
    );
    expect(await fetchLoginQuotaResetAt(login('latest'), 1000, probes)).toBe(9000);
  });

  test('a cached reading that predates the limit is read again', async () => {
    const source = login('stale');
    const { probes, calls } = probing(
      reading(false, [{ id: 'five_hour', usedPercent: 60, windowMinutes: 300, resetsAt: 5000 }]),
      reading(true, [{ id: 'five_hour', usedPercent: 100, windowMinutes: 300, resetsAt: 5000 }]),
    );
    expect(await fetchLoginQuotaResetAt(source, 1000, probes)).toBe(5000);
    expect(calls()).toBe(2);
  });

  test('not used up, a reset already past, or a full window with no reset: unknown', async () => {
    const free = probing(
      reading(false, [{ id: 'five_hour', usedPercent: 30, windowMinutes: 300 }]),
    );
    expect(await fetchLoginQuotaResetAt(login('free'), 1000, free.probes)).toBeUndefined();
    const past = probing(
      reading(true, [{ id: 'five_hour', usedPercent: 100, windowMinutes: 300, resetsAt: 500 }]),
    );
    expect(await fetchLoginQuotaResetAt(login('past'), 1000, past.probes)).toBeUndefined();
    const unknown = probing(
      reading(true, [
        { id: 'five_hour', usedPercent: 100, windowMinutes: 300, resetsAt: 5000 },
        { id: 'seven_day', usedPercent: 100, windowMinutes: 10080 },
      ]),
    );
    expect(await fetchLoginQuotaResetAt(login('unknown'), 1000, unknown.probes)).toBeUndefined();
    expect(
      await fetchLoginQuotaResetAt(login('none'), 1000, probing(undefined).probes),
    ).toBeUndefined();
  });
});
