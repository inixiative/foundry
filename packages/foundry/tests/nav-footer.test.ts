import { expect, test } from 'bun:test';
import { capacityByProvider } from '../src/viewer/ui/capacity.js';

test('capacity is totalled per provider over usable subscriptions only', () => {
  const groups = capacityByProvider([
    {
      provider: 'claude-code',
      source: 'login',
      detail: 'Claude Max · inixiative',
      ready: true,
      uses: ['main thread'],
    },
    {
      provider: 'claude-code',
      source: 'profile',
      detail: 'Claude Max · personal',
      ready: false,
      uses: ['decisions'],
    },
    { provider: 'groq', source: 'none', detail: 'GROQ_API_KEY not set', ready: false, uses: [] },
    { provider: 'codex', source: 'login', detail: 'ChatGPT Pro', ready: true, uses: ['decisions'] },
  ]);
  expect(groups.map((g) => [g.provider, g.ready, g.accounts.length])).toEqual([
    ['claude-code', 1, 2],
    ['codex', 1, 1],
  ]);
  expect(capacityByProvider(null)).toEqual([]);
});
