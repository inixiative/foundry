/**
 * @atlas
 * @kind transformer
 * @partOf feature:viewer, feature:wardens
 */
import type { SystemActivity } from '@inixiative/foundry-core';
import type { ProjectHostState } from '../providers/project-warden-hosts';
import { projectHostActivity } from './system-activity';

/** Where a project's Wardens run: this machine's host, dev mode's Chorus, or hosted Chorus through Kingdom. */

/** One layer's host: its state as the strip says it (`projectHostActivity`), and the host's own report. */
export interface WardenLayerHealth {
  readonly state: SystemActivity['state'];
  readonly summary: string;
  readonly status: ProjectHostState['status'] | 'not-open';
  readonly held: number;
  readonly expected: number;
  readonly reason?: string;
  /** A later stage's model and effort (`claude-sonnet-5-5 at low`). */
  readonly lane?: string;
}

export interface ProjectWardenHealth {
  readonly projectId: string;
  readonly label: string;
  readonly on: boolean;
  /** Dev mode is on for the project (`devModeOn`), whether or not its chorus is. */
  readonly devMode: boolean;
  /** Why the chorus is off, when it is. */
  readonly reason?: string;
  /** The remote Chorus that answered (a dev URL or `kingdom:<host>`). */
  readonly remote?: string;
  /** Layer 1, the first stage's host. A remote Chorus reports one host for every stage, so this alone. */
  readonly layer1?: WardenLayerHealth;
  /** Each later stage's own host (a local chorus's Layer 2 lane). */
  readonly layer2: readonly WardenLayerHealth[];
  /** The worst layer's state: the status strip's `state`, not the host's own `status`. */
  readonly state: SystemActivity['state'];
  /** No layer failed or degraded: starting and resting are healthy. */
  readonly ok: boolean;
}

export interface WardenHostHealth {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly projects: readonly ProjectWardenHealth[];
}

/** What the route knows of a project before its hosts are read. */
export type WardenHealthInput = Pick<
  ProjectWardenHealth,
  'projectId' | 'label' | 'on' | 'devMode' | 'reason'
>;

const SEVERITY: Record<SystemActivity['state'], number> = {
  idle: 0,
  ready: 1,
  working: 2,
  degraded: 3,
  failed: 4,
};

const isHealthy = (state: SystemActivity['state']) => state !== 'failed' && state !== 'degraded';

function layerHealth(projectId: string, label: string, state: ProjectHostState): WardenLayerHealth {
  const activity = projectHostActivity(projectId, label, state);
  return {
    state: activity.state,
    summary: activity.summary,
    status: state.status,
    held: state.held,
    expected: state.expected,
    ...(state.reason ? { reason: state.reason } : {}),
    ...(state.lane ? { lane: state.lane } : {}),
  };
}

/** A host not open yet rests until someone works in the project, as a closed one does. */
const notOpen = (label: string): WardenLayerHealth => ({
  state: 'idle',
  summary: `${label}'s Wardens are resting until someone works in the project.`,
  status: 'not-open',
  held: 0,
  expected: 0,
});

/**
 * Every project's Warden host health from the host snapshot (`decisionHosts`): Layer 1 is the project's
 * own entry, each Layer 2 lane its `<id> (<lane>)` entry. An off chorus is healthy and has no layers.
 */
export function wardenHostHealth(
  projects: readonly WardenHealthInput[],
  hosts: Readonly<Record<string, ProjectHostState>> | undefined,
  now = new Date(),
): WardenHostHealth {
  const entries = Object.entries(hosts ?? {});
  const health = projects.map((project): ProjectWardenHealth => {
    const base = {
      projectId: project.projectId,
      label: project.label,
      on: project.on,
      devMode: project.devMode,
      ...(project.reason ? { reason: project.reason } : {}),
    };
    if (!project.on) return { ...base, layer2: [], state: 'idle', ok: true };
    const own = hosts?.[project.projectId];
    const layer1 = own
      ? layerHealth(project.projectId, project.label, own)
      : notOpen(project.label);
    const layer2 = entries
      .filter(([key, state]) => state.lane && key === `${project.projectId} (${state.lane})`)
      .map(([, state]) => layerHealth(project.projectId, project.label, state));
    const state = [layer1, ...layer2].reduce<SystemActivity['state']>(
      (worst, layer) => (SEVERITY[layer.state] > SEVERITY[worst] ? layer.state : worst),
      'idle',
    );
    return {
      ...base,
      ...(own?.remote ? { remote: own.remote } : {}),
      layer1,
      layer2,
      state,
      ok: isHealthy(state),
    };
  });
  return {
    ok: health.every((project) => project.ok),
    checkedAt: now.toISOString(),
    projects: health,
  };
}
