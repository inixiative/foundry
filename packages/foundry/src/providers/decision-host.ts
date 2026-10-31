/**
 * @atlas
 * @kind service
 * @partOf primitive:decisions
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type LimitSnapshot, probeClaudeLimits } from '@inixiative/agent-session';
import type { LLMProvider } from '@inixiative/foundry-core';
import { largestRoster, largestStageCount } from '../agents/configured-experts';
import type { StageConfig, StageEffort } from '../classify';
import { type FoundryConfig, starterConfig } from '../viewer/config';
import type { InSessionWardens } from './in-session-wardens';
import {
  createSubscriptionDecisions,
  type SubscriptionDecisionConfig,
} from './subscription-decisions';
import {
  resolveSubscriptionPolicy,
  type SubscriptionResolution,
  type SubscriptionSettings,
} from './subscription-policy';

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
    subagents?: { processes: number; membersPerProcess: number };
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
    ...(overrides.subagents ? { subagents: overrides.subagents } : {}),
  });
}

/**
 * The Claude login's usage reading (each window's percent used and reset time, the plan), as the CLI
 * reports it over its control channel: no model call. Undefined when the CLI does not answer.
 */
export async function claudeLimits(cwd: string): Promise<LimitSnapshot | undefined> {
  try {
    return (await probeClaudeLimits({ cwd, timeoutMs: 30_000 })) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Claude login's usage windows (percent used per window id, e.g. `five_hour`), as the CLI
 * reports them: an offline job checks it before spending the shared subscription. Undefined when
 * the CLI does not answer.
 */
export async function claudeUsageWindows(cwd: string): Promise<Record<string, number> | undefined> {
  const snapshot = await claudeLimits(cwd);
  if (!snapshot) return undefined;
  return Object.fromEntries(snapshot.windows.map((w) => [w.id, w.usedPercent]));
}

/** What the daemon's decision hosts report: pressure and primed-host events, observers only. */
export type DecisionEvents = Pick<SubscriptionDecisionConfig, 'onPressure' | 'onPrimedEvent'>;

/**
 * The daemon's subscription decision hosts, as a live Foundry runs them: the decision host (the
 * Cartographer, the decision roles and every Warden stage on the decision model and effort), and one
 * host per other model and effort a classify stage names (`chorus.wardens.stages`), started on first
 * use on the same login and bounds. `stageHost` answers `null` for the decision pair (the Warden's own
 * provider serves it). Every primed pool is sized for the largest chorus any project runs.
 */
export function liveDecisionHosts(
  config: FoundryConfig,
  subscription: SubscriptionResolution,
  opts: {
    inSession?: InSessionWardens;
    events?: DecisionEvents;
    log?: (line: string) => void;
  } = {},
) {
  const { policy } = subscription;
  /** Whether a classify stage runs on the decision host (its model and effort are the decision ones). */
  const onDecisionHost = (stage: StageConfig) =>
    (stage.model ?? policy.model) === policy.model &&
    (stage.effort ?? policy.effort) === policy.effort;
  const decisions = createSubscriptionDecisions({
    ...policy,
    source: subscription.decision,
    ...(opts.inSession ? { inSession: opts.inSession } : {}),
    // Every decision role stays primed: a key per classify stage and a review key per Warden, plus
    // the Cartographer, the router roles and the feedback lifecycle. An evicted key re-primes cold.
    // Sized for the largest chorus any project runs (region Wardens are per project).
    primedSessions: Math.max(
      16,
      (largestStageCount(config, onDecisionHost) + 1) * largestRoster(config) + 8,
    ),
    ...opts.events,
  });
  const stageHosts = new Map<string, ReturnType<typeof createSubscriptionDecisions>>();
  const stageHost = (
    model: string | undefined,
    effort: StageEffort | undefined,
  ): LLMProvider | null => {
    const m = model ?? policy.model;
    const e = effort ?? policy.effort;
    if (m === policy.model && e === policy.effort) return null;
    const key = `${m}|${e ?? ''}`;
    let host = stageHosts.get(key);
    if (!host) {
      host = createSubscriptionDecisions({
        ...policy,
        source: subscription.decision,
        model: m,
        ...(e ? { effort: e } : {}),
        // A key per stage this host serves, per Warden.
        primedSessions: Math.max(
          16,
          largestStageCount(
            config,
            (stage) => (stage.model ?? policy.model) === m && (stage.effort ?? policy.effort) === e,
          ) *
            largestRoster(config) +
            8,
        ),
        ...opts.events,
      });
      stageHosts.set(key, host);
      opts.log?.(`[subscription-decisions] stage host ${m}${e ? ` at ${e}` : ''} started`);
    }
    return host.provider;
  };
  return {
    decisions,
    stageHost,
    /** Stops the decision host and every stage host. */
    shutdown: async () => {
      await Promise.all([
        decisions.shutdown(),
        ...[...stageHosts.values()].map((host) => host.shutdown()),
      ]);
    },
  };
}
