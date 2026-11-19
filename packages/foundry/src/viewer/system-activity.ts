/**
 * @atlas
 * @kind transformer
 * @partOf feature:viewer, feature:wardens
 */
import type { PrimedEvent } from '@inixiative/agent-session';
import type { SystemActivity } from '@inixiative/foundry-core';
import type { ProjectHostState } from '../providers/project-warden-hosts';
import type { DecisionPressure } from '../providers/subscription-decisions';

/** How long a shed decision stays in the strip when nothing replaces it. */
const SHED_SHOWN_MS = 30_000;

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;

/** A reset as this machine's clock reads it: "4:10 PM" today, with the day ("Tue 4:10 PM") on any other. */
export function resetTime(at: number, now = Date.now()): string {
  const time = { hour: 'numeric', minute: '2-digit' } as const;
  return new Date(at).toDateString() === new Date(now).toDateString()
    ? new Date(at).toLocaleTimeString([], time)
    : new Date(at).toLocaleString([], { weekday: 'short', ...time });
}

/**
 * A project's Warden host, said plainly: starting, refreshing or restarting is work in progress;
 * serving with no reason is ready; a failed start is degraded until the retry; failed for good is red.
 * Idle, closed or no Wardens is for the log only.
 */
export function projectHostActivity(
  projectId: string,
  projectLabel: string,
  state: ProjectHostState,
): SystemActivity {
  // A later stage's lane (Layer 2 on its own model) is its own line, never the decision host's.
  const base = {
    key: `project-wardens:${projectId}${state.lane ? `:${state.lane}` : ''}`,
    source: 'project-wardens',
    projectId,
  };
  if (state.lane) projectLabel = `${projectLabel} (${state.lane})`;
  const detail = `${projectId}${state.lane ? ` (${state.lane})` : ''} ${state.status}: ${state.held}/${state.expected} held${state.setupMs !== undefined ? `, set up in ${state.setupMs} ms` : ''}${state.rssMb !== undefined ? `, ${state.rssMb} MB` : ''}${state.reason ? ` (${state.reason})` : ''}`;
  const count = state.expected;
  const reason = state.reason;
  if (state.status === 'closed' || reason === 'idle' || reason === 'no Wardens')
    return {
      ...base,
      state: 'idle',
      summary: `${projectLabel}'s Wardens are resting until someone works in the project.`,
      detail,
    };
  // The login is out of usage: a serving host's Wardens cannot answer either. The strip says it once,
  // as the decision login's pause (`decisions:rate-limit`); each project's line is for the log.
  if (state.quotaResetsAt !== undefined)
    return {
      ...base,
      state: 'idle',
      until: state.quotaResetsAt,
      summary: `${projectLabel}'s Wardens are paused: the Claude login's usage is used up until ${resetTime(state.quotaResetsAt)}.`,
      detail,
    };
  if (state.status === 'failed')
    return {
      ...base,
      state: 'failed',
      summary: `${projectLabel}'s Wardens could not start; slower stand-ins remind meanwhile.`,
      detail,
    };
  if (reason?.startsWith('start failed'))
    return {
      ...base,
      state: 'degraded',
      summary: `${projectLabel}'s Wardens did not start; trying again shortly.`,
      detail,
    };
  if (reason === 'start' || reason === 'retry')
    return {
      ...base,
      state: 'working',
      summary: `Getting ${projectLabel}'s ${count} Wardens ready. Reminders may be slower until they are.`,
      detail,
    };
  if (reason === 'roster grew')
    return {
      ...base,
      state: 'working',
      summary: `Adding new Wardens to ${projectLabel}; the current ones keep answering.`,
      detail,
    };
  if (reason && reason !== 'roster refreshed')
    return {
      ...base,
      state: 'working',
      summary: `Restarting ${projectLabel}'s Wardens; the current ones keep answering.`,
      detail,
    };
  return {
    ...base,
    state: 'ready',
    summary: `${projectLabel}'s ${count} Wardens are ready.`,
    detail,
  };
}

/** Load on the decision login touches every thread: no project. */
export function decisionPressureActivity(
  event: DecisionPressure,
  now = Date.now(),
): SystemActivity {
  if (event.kind === 'closed')
    return {
      key: 'decisions:admission',
      source: 'subscription-decisions',
      state: 'failed',
      summary: 'Wardens stopped answering until Foundry restarts.',
      detail: `Decision admission closed until restart: ${event.reason}`,
    };
  if (event.kind === 'quota-resumed')
    return {
      key: 'decisions:rate-limit',
      source: 'subscription-decisions',
      state: 'idle',
      summary: "The Wardens' Claude login has usage again; they are answering.",
      detail: 'Decision login usage available again; decisions run',
    };
  if (event.kind === 'quota-paused')
    return {
      key: 'decisions:rate-limit',
      source: 'subscription-decisions',
      state: 'degraded',
      until: event.until,
      summary: `The Wardens' Claude login is out of usage; they pause until it resets at ${resetTime(event.until, now)}.`,
      detail: `Decision login usage used up; decisions refused until ${new Date(event.until).toISOString()}`,
    };
  if (event.kind === 'rate-limited')
    return {
      key: 'decisions:rate-limit',
      source: 'subscription-decisions',
      state: 'degraded',
      until: event.until,
      summary: `The Wardens' login hit its rate limit; reminders pause for ${seconds(event.backoffMs)}.`,
      detail: `Decision subscription rate limited; backing off ${seconds(event.backoffMs)}`,
    };
  return {
    key: 'decisions:load',
    source: 'subscription-decisions',
    state: 'degraded',
    until: now + SHED_SHOWN_MS,
    summary: 'Wardens are busy; some reminders were skipped.',
    detail: `Decision shed under load (thread ${event.threadId}, priority ${event.priority}, ${event.queued} queued)`,
  };
}

/** A decision process recycling is routine housekeeping: logged, never shown. */
export function primedEventActivity(event: PrimedEvent): SystemActivity | undefined {
  if (event.type !== 'process-recycled' && event.type !== 'violation') return undefined;
  return {
    key: 'decisions:process',
    source: 'subscription-decisions',
    state: 'idle',
    summary: 'A Warden process restarted.',
    detail:
      event.type === 'violation'
        ? `Decision violated the text-only policy (${event.detail}); process recycled`
        : `Decision process recycled (${event.reason}); roles re-prime on the next decision`,
  };
}
