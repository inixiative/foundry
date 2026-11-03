/**
 * @atlas
 * @kind helper
 * @partOf feature:daemon
 */
/**
 * What the running daemon tells its supervisor, in the same process. The supervisor runs from the
 * checkout and the daemon from a release (`scripts/daemon/update.ts`), so the two may be different
 * copies of this file: the registry key (`Symbol.for`) is the contract, not the module.
 */
import type { UpdateOffer } from './restart-roll';

const KEY = Symbol.for('inixiative.foundry.daemon.runtime');

export interface DaemonRuntimeHook {
  /** Turns queued or running here (a supervisor without `offerUpdate` drains on this). */
  liveTurns(): number;
  /**
   * A staged update: the daemon spins down (running turns finish, new ones wait) and calls
   * `offer.restart` once the last running turn finishes (`daemon/restart-roll.ts`).
   */
  offerUpdate?(offer: UpdateOffer): void;
}

export function publishDaemonRuntime(hook: DaemonRuntimeHook): void {
  (globalThis as Record<symbol, unknown>)[KEY] = hook;
}

/** The running daemon's hook, once it has booted. */
export function daemonRuntime(): DaemonRuntimeHook | undefined {
  const hook = (globalThis as Record<symbol, unknown>)[KEY] as DaemonRuntimeHook | undefined;
  return typeof hook?.liveTurns === 'function' ? hook : undefined;
}
