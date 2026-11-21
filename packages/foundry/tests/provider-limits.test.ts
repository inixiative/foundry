import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LimitSnapshot } from '@inixiative/agent-session';
import { defaultProfileSource } from '../src/providers/default-profiles';
import type { ProviderAccount } from '../src/providers/provider-accounts';
import {
  fetchLoginQuotaResetAt,
  LOGIN_UNREAD,
  makeLoginQuotaPause,
  providerLimits,
  usedUpResetAt,
} from '../src/providers/provider-limits';

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

  test('not used up or a reset already past: free; a full window with no reset: read again later', async () => {
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
    // Used up with no known reset: agent-session refuses it too, so it pauses until the next read.
    expect(await fetchLoginQuotaResetAt(login('unknown'), 1000, unknown.probes)).toBe(
      1000 + 15 * 60_000,
    );
    expect(await fetchLoginQuotaResetAt(login('none'), 1000, probing(undefined).probes)).toBe(
      LOGIN_UNREAD,
    );
  });

  test("any window at its limit binds, a model's own weekly one too: agent-session's rule", () => {
    const limits = reading(true, [
      { id: 'five_hour', usedPercent: 40, windowMinutes: 300, resetsAt: 5000 },
      { id: 'seven_day_opus', usedPercent: 100, windowMinutes: 10080, resetsAt: 90_000 },
    ]);
    expect(usedUpResetAt(limits, 1000)).toBe(90_000);
  });
});

describe('a login quota pause', () => {
  const used = (resetsAt: number): LimitSnapshot => ({
    runtime: 'claude',
    source: 'stream',
    observedAt: Date.now(),
    blocked: true,
    windows: [{ id: 'five_hour', usedPercent: 100, windowMinutes: 300, resetsAt }],
  });

  test('a reading the host reports pauses at once; a long pause is read again and ends when freed', async () => {
    let resetAt: number | undefined = Date.now() + 60_000;
    const pause = makeLoginQuotaPause({ fetchResetAt: async () => resetAt, recheckMs: 60 });
    const told: Array<number | undefined> = [];
    pause.onChange((until) => told.push(until));
    pause.observe(used(resetAt));
    expect(pause.pausedUntil()).toBe(resetAt);
    // Signed in again, say: the next read finds usage, and the pause ends before its reset.
    resetAt = undefined;
    await Bun.sleep(150);
    expect(pause.pausedUntil()).toBeUndefined();
    expect(told).toHaveLength(2);
    expect(told.at(-1)).toBeUndefined();
    pause.close();
  });

  test('reads of the login after rate limits are spaced, not one a retry', async () => {
    let fetched = 0;
    const pause = makeLoginQuotaPause({
      fetchResetAt: async () => {
        fetched++;
        return undefined;
      },
    });
    expect(await pause.read()).toBeUndefined();
    expect(await pause.read()).toBeUndefined();
    expect(fetched).toBe(1);
    pause.close();
  });

  test('a recheck the login does not answer keeps the pause; only a full read brings it earlier', async () => {
    const far = Date.now() + 60_000;
    let answer: number | undefined | typeof LOGIN_UNREAD = LOGIN_UNREAD;
    const pause = makeLoginQuotaPause({ fetchResetAt: async () => answer, recheckMs: 40 });
    const told: Array<number | undefined> = [];
    pause.onChange((until) => told.push(until));
    pause.observe(used(far));
    // A host's one rejected window, resetting sooner, does not cut a longer pause short.
    pause.observe(used(Date.now() + 5_000));
    expect(pause.pausedUntil()).toBe(far);
    await Bun.sleep(120);
    expect(pause.pausedUntil()).toBe(far);
    expect(told).toEqual([far]);
    // A full read that answers may move it earlier.
    const sooner = Date.now() + 30_000;
    answer = sooner;
    await Bun.sleep(120);
    expect(pause.pausedUntil()).toBe(sooner);
    expect(told).toEqual([far, sooner]);
    pause.close();
  });

  test("a pause's end reads the login again: a later window still at its limit carries it on", async () => {
    const soon = Date.now() + 60;
    const later = Date.now() + 60_000;
    const pause = makeLoginQuotaPause({ fetchResetAt: async () => later });
    const told: Array<number | undefined> = [];
    pause.onChange((until) => told.push(until));
    // The host's rate-limit event named only the five-hour window.
    pause.observe(used(soon));
    await Bun.sleep(120);
    expect(pause.pausedUntil()).toBe(later);
    expect(told).toEqual([soon, later]);
    pause.close();
  });

  test('used up with no known reset pauses until the login is read again', () => {
    const pause = makeLoginQuotaPause({ fetchResetAt: async () => undefined, recheckMs: 5_000 });
    pause.observe({
      runtime: 'claude',
      source: 'stream',
      observedAt: Date.now(),
      blocked: true,
      windows: [{ id: 'seven_day', usedPercent: 100, windowMinutes: 10080 }],
    });
    expect(pause.pausedUntil()).toBeGreaterThan(Date.now());
    pause.close();
  });
});
