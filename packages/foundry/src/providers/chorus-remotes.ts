/**
 * @atlas
 * @kind service
 * @partOf feature:wardens
 */
import type { ChorusProjectActivityResult } from '@inixiative/signet';
import type { DevRemoteSettings } from '../viewer/config';
import { type ChorusRemote, createChorusRemote } from './chorus-client';
import { directChorusTransport } from './chorus-direct-transport';
import { createKingdomChorusTransport, type SignetAccessHandle } from './kingdom-chorus-transport';
import type { ProjectHostState } from './project-warden-hosts';

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
 * Each project's host state comes from `chorus.projectActivity`, sent when a thread of it starts.
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

  return {
    remote,
    /** Drop cached Kingdom `access/describe` grants (call when Kingdom pushes a new snapshot). */
    invalidate(): void {
      for (const entry of remotes.values()) entry.invalidate?.();
    },
    /** Touch the project's remote host (a thread of it starts) and record what it reports. */
    async activate(projectId: string): Promise<void> {
      const chorus = remote(projectId);
      if (!chorus) return;
      const outcome = await chorus.call('chorus.projectActivity', { activity: 'touch' });
      if (!outcome.ok) {
        const reason =
          'failure' in outcome ? outcome.message : (outcome.message ?? outcome.refusal);
        options.log?.(`[Chorus] ${projectId}: projectActivity touch failed: ${reason}`);
        const state: ProjectHostState = {
          status: 'failed',
          reason,
          expected: 0,
          held: 0,
          failures: (hosts.get(projectId)?.failures ?? 0) + 1,
          resets: {},
          generation,
          remote: chorus.endpoint,
        };
        hosts.set(projectId, state);
        options.onHost?.(projectId, state);
        return;
      }
      generation += 1;
      const state = hostState(outcome.result, chorus.endpoint, generation);
      hosts.set(projectId, state);
      options.onHost?.(projectId, state);
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
