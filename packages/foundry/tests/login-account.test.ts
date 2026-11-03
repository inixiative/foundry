import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeProfileSource } from '../src/providers/default-profiles';
import {
  claudePlan,
  claudeTier,
  codexPlan,
  loginAccount,
  PLAN_UNKNOWN,
} from '../src/providers/login-account';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const login = (profileDirectory: string, runtime: 'claude' | 'codex' = 'claude') =>
  ({
    id: Bun.randomUUIDv7(),
    integrationId: Bun.randomUUIDv7(),
    runtime,
    mode: 'native-profile',
    profileDirectory,
  }) as NativeProfileSource;

test('plans read as specifically as the provider names them, never guessed', () => {
  expect(claudeTier('default_claude_max_20x')).toBe('Max 20x');
  expect(claudeTier('default_claude_max_5x')).toBe('Max 5x');
  expect(claudeTier('claude_pro')).toBe('Pro');
  expect(
    claudePlan({ planDisplayName: 'Ultra', organizationRateLimitTier: 'default_claude_max_20x' }),
  ).toBe('Claude Ultra (Max 20x)');
  expect(claudePlan({ organizationRateLimitTier: 'default_claude_max_5x' })).toBe('Claude Max 5x');
  expect(claudePlan({ organizationType: 'claude_team' })).toBe('Claude Team');
  expect(claudePlan({ emailAddress: 'a@b.c' })).toBeUndefined();
  expect(codexPlan('pro')).toBe('ChatGPT Pro');
  expect(codexPlan('plus')).toBe('ChatGPT Plus');
  expect(codexPlan(undefined)).toBeUndefined();
});

test("a Claude login's plan and account come from its own profile; none there is plan unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), 'login-account-'));
  roots.push(root);
  const signedIn = join(root, 'signed-in');
  mkdirSync(signedIn);
  writeFileSync(
    join(signedIn, '.claude.json'),
    JSON.stringify({
      oauthAccount: {
        emailAddress: 'aron@example.com',
        organizationName: 'Example',
        planDisplayName: 'Max',
        organizationRateLimitTier: 'default_claude_max_5x',
      },
    }),
  );
  expect(await loginAccount(login(signedIn))).toEqual({
    plan: 'Claude Max (Max 5x)',
    account: 'aron@example.com',
  });
  // A setup-token login keeps no profile: unknown, unless its usage reading names the plan.
  const token = join(root, 'token');
  mkdirSync(token);
  expect(await loginAccount(login(token))).toEqual({ plan: PLAN_UNKNOWN });
  expect(
    (
      await loginAccount(login(token), {
        runtime: 'claude',
        source: 'poll',
        observedAt: 1,
        windows: [],
        plan: 'max',
      })
    ).plan,
  ).toBe('Claude Max');
});

test("a Codex login's account read gives its plan and email", async () => {
  const read = async () => ({ plan: 'ChatGPT Pro', account: 'aron@example.com' });
  expect(await loginAccount(login('/tmp/codex-x', 'codex'), undefined, read)).toEqual({
    plan: 'ChatGPT Pro',
    account: 'aron@example.com',
  });
});
