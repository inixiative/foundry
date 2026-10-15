import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { probeClaudeLimits } from '@inixiative/agent-session';
import { starterConfig } from '../viewer/config';
import { createSubscriptionDecisions } from './subscription-decisions';
import { resolveSubscriptionPolicy, type SubscriptionSettings } from './subscription-policy';

/** A private (0700) directory, created when missing. */
export function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/**
 * A standalone subscription decision host for an offline job (repeat reports, evals): one model on
 * the machine's own login, its receipts under `state`. No daemon, no thread. `overrides.inputCap`
 * lifts the decision input cap for an eval that measures larger Wardens; live never sets it.
 * `overrides.effort` sets the decision effort (`'default'` leaves the model's own); live decisions
 * run the subscription policy's default.
 */
export function decisionHost(
  model: string,
  runtime: 'claude' | 'codex',
  concurrency: number,
  state: string,
  overrides: {
    inputCap?: number;
    primedSessions?: number;
    effort?: SubscriptionSettings['effort'] | 'default';
  } = {},
) {
  const directory = privateDirectory(join(state, 'decision-receipts'));
  const config = starterConfig('claude-code', 'sonnet');
  config.subscriptionOnly = {
    decisionRuntime: runtime,
    model,
    directory,
    maxConcurrent: concurrency,
    maxQueued: 1_024,
    maxQueuedPerThread: 1_024,
    ...(overrides.effort && overrides.effort !== 'default' ? { effort: overrides.effort } : {}),
  };
  const resolved = resolveSubscriptionPolicy(config, { startup: true, cwd: state });
  if (!resolved) throw Error('Offline decisions run on subscription decisions only');
  return createSubscriptionDecisions({
    ...resolved.policy,
    source: resolved.decision,
    ...(overrides.effort === 'default' ? { effort: undefined } : {}),
    ...(overrides.inputCap !== undefined ? { inputCap: overrides.inputCap } : {}),
    ...(overrides.primedSessions !== undefined ? { primedSessions: overrides.primedSessions } : {}),
  });
}

/**
 * The Claude login's usage windows (percent used per window id, e.g. `five_hour`), as the CLI
 * reports them: an offline job checks it before spending the shared subscription. Undefined when
 * the CLI does not answer.
 */
export async function claudeUsageWindows(cwd: string): Promise<Record<string, number> | undefined> {
  try {
    const snapshot = await probeClaudeLimits({ cwd, timeoutMs: 30_000 });
    if (!snapshot) return undefined;
    return Object.fromEntries(snapshot.windows.map((w) => [w.id, w.usedPercent]));
  } catch {
    return undefined;
  }
}
