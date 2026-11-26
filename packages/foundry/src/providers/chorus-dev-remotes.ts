/**
 * @atlas
 * @kind service
 * @partOf feature:wardens
 */
import type { ChorusProjectActivityResult } from '@inixiative/signet';
import { type ChorusRemote, createChorusRemote } from './chorus-client';
import { directChorusTransport } from './chorus-direct-transport';
import type { ProjectHostState } from './project-warden-hosts';

/** Dev mode's Chorus (`__chorus`, only while `__devMode` is on): its URL and the keychain entry naming its token. */
export interface ChorusDevSetting {
  readonly url: string;
  readonly tokenKey: string;
}

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

/**
 * Dev mode's remote Choruses, one per project, read from the live settings on every ask: dev mode
 * turned on, off or pointed elsewhere takes effect on the next Warden call. The token is read by its
 * keychain name (falling back to the environment variable of that name) and kept once found. Each
 * project's host state comes from `chorus.projectActivity`, sent when a thread of it starts.
 */
export function chorusDevRemotes(options: {
  readonly setting: () => ChorusDevSetting | undefined;
  readonly readToken: (name: string) => Promise<string | undefined>;
  readonly log?: (message: string) => void;
  readonly onHost?: (projectId: string, state: ProjectHostState) => void;
}) {
  const remotes = new Map<string, ChorusRemote>();
  const tokens = new Map<string, string>();
  const hosts = new Map<string, ProjectHostState>();
  let generation = 0;
  const token = (name: string) => async () => {
    const held = tokens.get(name);
    if (held) return held;
    const read = await options.readToken(name);
    if (read) tokens.set(name, read);
    return read;
  };
  const remote = (projectId: string): ChorusRemote | undefined => {
    const setting = options.setting();
    if (!setting) return undefined;
    const key = `${setting.url}\u0000${setting.tokenKey}\u0000${projectId}`;
    const known = remotes.get(key);
    if (known) return known;
    const made = createChorusRemote({
      projectId,
      endpoint: setting.url,
      transport: directChorusTransport(setting.url, token(setting.tokenKey)),
      ...(options.log ? { log: options.log } : {}),
    });
    remotes.set(key, made);
    return made;
  };
  return {
    remote,
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
    /** Every remote project's last reported host state, while dev mode is on. */
    snapshot(): Record<string, ProjectHostState> {
      return options.setting() ? Object.fromEntries(hosts) : {};
    },
  };
}
