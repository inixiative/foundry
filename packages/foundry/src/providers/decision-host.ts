/**
 * @atlas
 * @kind service
 * @partOf primitive:decisions
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { type LimitSnapshot, type PrimedEvent, probeClaudeLimits } from '@inixiative/agent-session';
import type { LLMProvider } from '@inixiative/foundry-core';
import type { StageEffort } from '../classify';
import { type ProjectHostState, ProjectWardenHosts } from './project-warden-hosts';
import {
  createSubscriptionDecisions,
  type SubscriptionDecisionConfig,
} from './subscription-decisions';
import type { SubscriptionPolicy, SubscriptionResolution } from './subscription-policy';

/** How a project host reaches its caller: the thread → project lookup and state observer. */
export interface ProjectHostOptions {
  /** The project a decision's thread belongs to (the daemon: `threadMeta(thread).projectId`). */
  projectOf: (threadId: string) => string | undefined;
  onProject?: (projectId: string, state: ProjectHostState) => void;
  /** The project hosts' own events (held-spare decisions, standby turns, recycles, limits). */
  onEvent?: (event: PrimedEvent) => void;
}

/** The registry of project Warden hosts, on the decision model and effort. */
function projectWardenHosts(
  policy: SubscriptionPolicy,
  options: ProjectHostOptions,
): ProjectWardenHosts {
  return new ProjectWardenHosts({
    model: policy.model,
    ...(policy.effort ? { effort: policy.effort } : {}),
    timeoutMs: policy.callTimeoutMs,
    projectOf: options.projectOf,
    projectHost: policy.projectHost,
    ...(options.onProject ? { onProject: options.onProject } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
}

/** A private (0700) directory, created when missing. */
export function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
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

/** What the daemon's decision hosts report: scheduler pressure and the project hosts' events, observers only. */
export type DecisionEvents = Pick<SubscriptionDecisionConfig, 'onPressure'> & {
  onHostEvent?: (event: PrimedEvent) => void;
};

/**
 * The daemon's subscription decision hosts, as a live Foundry runs them: the decision host (every
 * Warden stage on the decision model and effort), and one host per other model and effort a classify
 * stage names (`chorus.wardens.stages`), started on first use on the same login and bounds.
 * `stageHost` answers `null` for the decision pair (the Warden's own provider serves it). Every
 * Warden call (advice, guard, review, stage) runs in its project's one process, and is skipped while
 * its host or lane does not serve ("it should not be handling warden calls at all",
 * R-2026-11-18-38/39).
 */
export function liveDecisionHosts(
  subscription: SubscriptionResolution,
  opts: {
    /** The project hosts' thread → project lookup and observers; built here, on the decision host's login. */
    project: ProjectHostOptions;
    events?: DecisionEvents;
    log?: (line: string) => void;
  },
) {
  const { policy } = subscription;
  const { onHostEvent, ...schedulerEvents } = opts.events ?? {};
  const projectHosts = projectWardenHosts(policy, {
    ...(onHostEvent ? { onEvent: onHostEvent } : {}),
    ...opts.project,
  });
  const decisions = createSubscriptionDecisions({
    ...policy,
    source: subscription.decision,
    projectHosts,
    ...schedulerEvents,
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
        // The same login: one used-up pause, the decision host's.
        ...(decisions.quota ? { quota: decisions.quota } : {}),
        model: m,
        ...(e ? { effort: e } : {}),
        // Its stage held in each project's host on this model (a lane of the decision one's).
        projectHosts: projectHosts.lane(m, e),
        ...schedulerEvents,
      });
      stageHosts.set(key, host);
      opts.log?.(`[subscription-decisions] stage host ${m}${e ? ` at ${e}` : ''} started`);
    }
    return host.provider;
  };
  /**
   * The project hosts holding a classify stage on this model and effort: the decision ones for the
   * decision pair, else the stage host's lane (that stage host started if it was not: it binds the
   * lane's launcher).
   */
  const stageProjectHosts = (
    model: string | undefined,
    effort: StageEffort | undefined,
  ): ProjectWardenHosts => {
    stageHost(model, effort);
    return projectHosts.lane(model ?? policy.model, effort ?? policy.effort);
  };
  return {
    decisions,
    stageHost,
    /** Every project's Warden host (open one with `openProject`). */
    projectHosts,
    stageProjectHosts,
    /** Stops the decision host, every stage host and every project host. */
    shutdown: async () => {
      await Promise.all([
        decisions.shutdown(),
        ...[...stageHosts.values()].map((host) => host.shutdown()),
        projectHosts.close(),
      ]);
    },
  };
}
