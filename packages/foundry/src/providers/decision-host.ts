import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { starterConfig } from '../viewer/config';
import { createSubscriptionDecisions } from './subscription-decisions';
import { resolveSubscriptionPolicy } from './subscription-policy';

/** A private (0700) directory, created when missing. */
export function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/**
 * A standalone subscription decision host for an offline job (repeat reports, evals): one model on
 * the machine's own login, its receipts under `state`. No daemon, no thread.
 */
export function decisionHost(
  model: string,
  runtime: 'claude' | 'codex',
  concurrency: number,
  state: string,
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
  };
  const resolved = resolveSubscriptionPolicy(config, { startup: true, cwd: state });
  if (!resolved) throw Error('Offline decisions run on subscription decisions only');
  return createSubscriptionDecisions({ ...resolved.policy, source: resolved.decision });
}
