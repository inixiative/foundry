import { expect, test } from 'bun:test';
import type { LimitSnapshot } from '@inixiative/agent-session';
import type { ProviderAccount } from '../src/providers/provider-accounts';
import { providerLimits } from '../src/providers/provider-limits';

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
