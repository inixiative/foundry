/**
 * @atlas
 * @kind helper
 * @partOf feature:daemon
 */
/**
 * The supervisor serves the status page on the viewer's port while a release boots, and hands the
 * port over at the moment the viewer binds it, so the port is never dark through a boot that can
 * take minutes. Supervisor and daemon share a process but may be different copies of this file (the
 * checkout's and a release's), so the registry key (`Symbol.for`) is the contract, as it is for
 * `runtime-hook.ts`.
 */

const KEY = Symbol.for('inixiative.foundry.daemon.port-holder');

/** Stops whatever holds the viewer's port; resolves once the port is free. */
export type ReleaseHeldPort = () => Promise<void>;

export function publishPortHolder(release: ReleaseHeldPort): void {
  (globalThis as Record<symbol, unknown>)[KEY] = release;
}

/** Frees the viewer's port when the supervisor holds it; nothing to do when no one does. */
export async function releaseHeldPort(): Promise<void> {
  const release = (globalThis as Record<symbol, unknown>)[KEY] as ReleaseHeldPort | undefined;
  if (typeof release !== 'function') return;
  delete (globalThis as Record<symbol, unknown>)[KEY];
  await release();
}
