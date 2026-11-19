/**
 * @atlas
 * @kind helper, component
 * @partOf feature:daemon, feature:viewer
 */
/**
 * What the restart says (packages/foundry/src/daemon/restart-roll.ts), as plain lines: an update's
 * spin-down, or a restart the owner asked for with its blockers counted (Aron, 2026-11-16). Pure:
 * `update-notice.js` and the system strip render what these return.
 */

const short = (sha) => (sha ? sha.slice(0, 8) : '');
const turns = (n) => `${n} turn${n === 1 ? '' : 's'}`;

/** What a restart still waits for: each running turn. */
export function restartBlockers(state) {
  return state?.running?.length ?? 0;
}

/** One line for the update state, or null when there is nothing to say. */
export function updateLine(state) {
  if (!state) return null;
  if (state.phase === 'spinning-down' && state.reason) {
    // A restart the owner asked for (no update): the blockers counter, then what they are.
    const blockers = restartBlockers(state);
    if (!blockers) return 'Restarting now';
    const running = state.running?.length ?? 0;
    const pausing = state.pausing?.length ?? 0;
    const parts = [];
    if (pausing) parts.push(`pausing ${turns(pausing)}`);
    const unpaused = running - pausing;
    const left = state.pauseAtLocal ? Math.ceil((state.pauseAtLocal - Date.now()) / 1000) : 0;
    if (unpaused)
      parts.push(
        left > 0
          ? `${turns(unpaused)} running, paused in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} unless ${unpaused === 1 ? 'it finishes' : 'they finish'}`
          : `${turns(unpaused)} running`,
      );
    return `Restarting: ${blockers} blocker${blockers === 1 ? '' : 's'} left (${parts.join(', ')})`;
  }
  if (state.phase === 'spinning-down') {
    const running = state.running?.length ?? 0;
    const pausing = state.pausing?.length ?? 0;
    if (pausing && pausing === running)
      return `Update ready: pausing ${turns(running)}; ${running === 1 ? 'it resumes' : 'they resume'} after the restart`;
    // Only the turns not yet pausing wait out the grace.
    const unpaused = running - pausing;
    const left = state.pauseAtLocal ? Math.ceil((state.pauseAtLocal - Date.now()) / 1000) : 0;
    if (unpaused && left > 0) {
      return `Update ready: pausing ${turns(unpaused)} in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} unless ${unpaused === 1 ? 'it finishes' : 'they finish'}`;
    }
    // The grace is over: the daemon pauses them on its next look, within a few seconds.
    if (unpaused && state.pauseAtLocal) return `Update ready: pausing ${turns(unpaused)} now`;
    if (running)
      return `Update ready: restarting when ${turns(running)} finish${running === 1 ? 'es' : ''}`;
    return 'Update ready: restarting now';
  }
  if (state.phase === 'restarting')
    return state.reason ? 'Restarting…' : 'Restarting onto the update…';
  if (state.phase === 'postponed') return `Update ${short(state.candidate)} postponed`;
  return null;
}
