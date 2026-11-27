/**
 * @atlas
 * @kind service
 * @partOf feature:wardens
 */
import type { ChorusProjectActivityResult } from '@inixiative/signet';
import type { DevRemoteSettings } from '../viewer/config';
import { makeUnrefInterval } from '../ws/unref-interval';
import { type ChorusRemote, createChorusRemote } from './chorus-client';
import { directChorusTransport } from './chorus-direct-transport';
import { createKingdomChorusTransport, type SignetAccessHandle } from './kingdom-chorus-transport';
import type { ProjectHostState } from './project-warden-hosts';

/** A failed call in words, keeping a refusal's code (`unknown_project: No chorus project p`). */
const refusalReason = (outcome: {
  readonly message?: string;
  readonly refusal?: string;
}): string => {
  if (!outcome.refusal) return outcome.message ?? 'failed';
  if (!outcome.message) return outcome.refusal;
  return `${outcome.refusal}: ${outcome.message}`;
};

/** The host state a remote Chorus reports for one project, as the viewer shows a local host's. */
const hostState = (
  activity: ChorusProjectActivityResult,
  endpoint: string,
  generation: number,
): ProjectHostState => ({
  // A degraded host serves; its down Wardens say what it can't (`wardensDown`), as a local host's do.
  status: activity.status === 'degraded' ? 'serving' : activity.status,
  ...(activity.reason ? { reason: activity.reason } : {}),
  expected: activity.expectedWardens,
  held: activity.heldWardens,
  failures: 0,
  ...(activity.wardensDown.length ? { wardensDown: [...activity.wardensDown] } : {}),
  resets: {},
  generation,
  remote: endpoint,
});

/** Whether two reports say the same thing (a failure count rising is not news). */
const sameHostState = (a: ProjectHostState, b: ProjectHostState) =>
  a.status === b.status &&
  a.reason === b.reason &&
  a.held === b.held &&
  a.expected === b.expected &&
  a.remote === b.remote &&
  (a.wardensDown ?? []).join(',') === (b.wardensDown ?? []).join(',');

export interface HostedProjectTarget {
  readonly key: string;
  readonly endpoint: string;
  readonly kingdomProjectId: string;
  readonly signets: () => Promise<readonly SignetAccessHandle[]>;
}

/**
 * Remote Choruses for every project, read from live settings on every ask:
 * - In dev mode (`__devMode` + `__chorus`, R-2026-11-25-05), calls go straight to the local Chorus
 *   URL via `directChorusTransport`, no Kingdom.
 * - Otherwise, when a project is linked to a paired Kingdom (`projects.<id>.kingdomProject`), calls
 *   go through Kingdom's relay via `createKingdomChorusTransport`.
 * Each project's host state comes from `chorus.projectActivity`: `touch` when a thread of it starts,
 * then `status` on every poll (`poll`) and on demand (`check`), which reads without keeping it warm.
 */
export function chorusRemotes(options: {
  readonly devSetting: (projectId: string) => Required<DevRemoteSettings> | undefined;
  readonly readToken: (name: string) => Promise<string | undefined>;
  readonly hostedProject?: (projectId: string) => HostedProjectTarget | undefined;
  readonly log?: (message: string) => void;
  readonly onHost?: (projectId: string, state: ProjectHostState) => void;
}) {
  const remotes = new Map<
    string,
    { readonly remote: ChorusRemote; readonly invalidate?: () => void }
  >();
  const hosts = new Map<string, ProjectHostState>();
  let generation = 0;

  const remote = (projectId: string): ChorusRemote | undefined => {
    const setting = options.devSetting(projectId);
    if (setting) {
      const key = `dev\u0000${setting.url}\u0000${setting.tokenKey}\u0000${projectId}`;
      const known = remotes.get(key);
      if (known) return known.remote;
      const made = createChorusRemote({
        projectId,
        endpoint: setting.url,
        transport: directChorusTransport(setting.url, () => options.readToken(setting.tokenKey)),
      });
      remotes.set(key, { remote: made });
      return made;
    }

    const hosted = options.hostedProject?.(projectId);
    if (!hosted) return undefined;
    const key = `kingdom\u0000${hosted.key}\u0000${hosted.kingdomProjectId}`;
    const known = remotes.get(key);
    if (known) return known.remote;
    const transportHandle = createKingdomChorusTransport({
      endpoint: hosted.endpoint,
      signets: hosted.signets,
    });
    const made = createChorusRemote({
      projectId: hosted.kingdomProjectId,
      endpoint: hosted.endpoint,
      transport: transportHandle.transport,
    });
    remotes.set(key, { remote: made, invalidate: transportHandle.invalidate });
    return made;
  };

  /** Records a report, telling `onHost` only when it says something new (a poll repeats itself). */
  const record = (projectId: string, state: ProjectHostState) => {
    const before = hosts.get(projectId);
    hosts.set(projectId, state);
    if (!before || !sameHostState(before, state)) options.onHost?.(projectId, state);
  };

  const ask = async (projectId: string, activity: 'touch' | 'status'): Promise<void> => {
    const chorus = remote(projectId);
    if (!chorus) return;
    const outcome = await chorus.call('chorus.projectActivity', { activity });
    const before = hosts.get(projectId);
    if (outcome.ok) {
      if (activity === 'touch') generation += 1;
      record(projectId, hostState(outcome.result, chorus.endpoint, generation));
      return;
    }
    const reason = refusalReason(outcome);
    if (before?.status !== 'failed' || before.reason !== reason)
      options.log?.(`[Chorus] ${projectId}: projectActivity ${activity} failed: ${reason}`);
    record(projectId, {
      expected: 0,
      held: 0,
      resets: {},
      generation,
      remote: chorus.endpoint,
      status: 'failed',
      reason,
      failures: (before?.failures ?? 0) + 1,
    });
  };

  // Only a touch adds a project to the poll; a doctor's one-off ask never does.
  const activated = new Set<string>();

  const check = async (projectId: string, evenIfNotActivated = false): Promise<void> => {
    const known = hosts.get(projectId);
    const current = activated.has(projectId) && remote(projectId)?.endpoint === known?.remote;
    if (!current && !evenIfNotActivated) return;
    await ask(projectId, 'status');
  };

  return {
    remote,
    /** Drop cached Kingdom `access/describe` grants (call when Kingdom pushes a new snapshot). */
    invalidate(): void {
      for (const entry of remotes.values()) entry.invalidate?.();
    },
    /** Touch the project's remote host (a thread of it starts) and record what it reports. */
    activate: (projectId: string) => {
      activated.add(projectId);
      return ask(projectId, 'touch');
    },
    /**
     * Ask an activated project's remote host how it stands, without touching it (a poll never keeps
     * a host warm or opens one). A project no remote serves, or one never activated, is left alone
     * unless `evenIfNotActivated` (the doctor asking now), which never adds it to the poll.
     */
    check,
    /** `check` every activated project every `intervalMs`; returns the stop. */
    poll(intervalMs: number): () => void {
      const interval = makeUnrefInterval({
        intervalMs,
        tick: () => {
          for (const projectId of activated) void check(projectId);
        },
      });
      interval.start();
      return interval.stop;
    },
    /** Every remote project's last reported host state while it still points at the same remote Chorus. */
    snapshot(): Record<string, ProjectHostState> {
      const active: Record<string, ProjectHostState> = {};
      for (const [projectId, state] of hosts) {
        const current = remote(projectId);
        if (current && current.endpoint === state.remote) active[projectId] = state;
      }
      return active;
    },
  };
}
