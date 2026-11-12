/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * What the system is doing around a thread, not in it (Aron, 2026-11-11): one plain line above the
 * composer, in the status colours, with the technical log behind a chevron. Pure: the component in
 * conversation.js renders what `stripView` returns.
 */

/** How long "ready" stays before it fades. */
export const READY_SHOWN_MS = 4000;

const RANK = { failed: 0, degraded: 1, working: 2, ready: 3 };

/** Whether one activity shows now: idle never, ready briefly, one with `until` only until then. */
export function shows(activity, now = Date.now()) {
  if (!activity || !(activity.state in RANK)) return false;
  if (activity.until !== undefined && now >= activity.until) return false;
  if (activity.state === 'ready') return now - activity.timestamp < READY_SHOWN_MS;
  return true;
}

/**
 * The strip for these activities: the most pressing one as the headline (failed, then degraded,
 * then working, then ready; the newest within a state), how many others show, and the colour.
 * Null when nothing shows.
 */
export function stripView(activities, now = Date.now()) {
  const showing = (Array.isArray(activities) ? activities : [])
    .filter((a) => shows(a, now))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.timestamp - a.timestamp);
  if (!showing.length) return null;
  const head = showing[0];
  return {
    head,
    others: showing.slice(1),
    state: head.state,
    elapsed: head.state === 'working' ? elapsedLabel(now - head.timestamp) : null,
  };
}

/** "12s", "2m 5s": how long the headline's work has run. */
export function elapsedLabel(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}
