/**
 * @atlas
 * @kind service
 * @partOf feature:daemon
 */
/**
 * The daemon's status as its status page shows it, one shape from both servers: the supervisor's
 * (while nothing is booted) and the running viewer's (`/status`). Everything but the live part is
 * read from the files the supervisor keeps under `<config>/releases`.
 */
import { type BootRecord, type Hold, readBoots, readHold } from './boot-record';
import { type AutoUpdate, readAutoUpdate, readState } from './release-state';

/** What the process is doing now. `held` waits for a reason to boot; `running` is the viewer answering. */
export type DaemonPhase =
  | 'checking-for-update'
  | 'starting-services'
  | 'booting'
  | 'held'
  | 'running';

export interface DaemonLiveStatus {
  /** Which server answered: the supervisor's status page, or the booted daemon's viewer. */
  readonly servedBy: 'supervisor' | 'daemon';
  /** This process: a page that sees it change is talking to a new one. */
  readonly bootId: string;
  readonly phase: DaemonPhase;
  readonly phaseSince: number;
  /** The release this process boots or runs; none for a daemon started from a checkout. */
  readonly release?: { readonly sha: string; readonly trial: boolean };
  readonly logDir?: string;
}

export interface DaemonStatus extends DaemonLiveStatus {
  readonly now: number;
  readonly stable?: string;
  readonly candidate?: string;
  readonly failed: readonly string[];
  readonly autoUpdate: AutoUpdate;
  readonly hold?: Hold;
  /** The latest boots, newest first. */
  readonly boots: readonly BootRecord[];
}

const SHOWN_BOOTS = 20;

export async function readDaemonStatus(
  configDir: string,
  live: DaemonLiveStatus,
): Promise<DaemonStatus> {
  const state = await readState(configDir);
  const hold = readHold(configDir);
  return {
    ...live,
    now: Date.now(),
    ...(state.stable ? { stable: state.stable } : {}),
    ...(state.candidate ? { candidate: state.candidate } : {}),
    failed: state.failed,
    autoUpdate: await readAutoUpdate(configDir),
    ...(hold ? { hold } : {}),
    boots: readBoots(configDir).slice(-SHOWN_BOOTS).reverse(),
  };
}
