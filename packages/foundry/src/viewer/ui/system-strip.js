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

/** Activities whose fix is a restart of Foundry: their strip row carries Restart, so it stays. */
export const NEEDS_RESTART = new Set(['decisions:admission']);

/**
 * Whether this thread was already advised of the activity's outage (Aron, 2026-11-17: "advise once,
 * but not every fucking round of a thread"): the person sent a message here after the outage began,
 * with the strip in view. It stays quiet until the outage ends, retries in it included; a new outage
 * is advised again. One whose fix is an action (Restart) stays until acted on.
 */
export function advised(activity, advisedAt) {
  if (advisedAt === undefined || activity?.outageStartedAt === undefined) return false;
  if (NEEDS_RESTART.has(activity.key)) return false;
  return activity.outageStartedAt < advisedAt;
}

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
 * `advisedAt` is when the person last sent a message in this thread; outages it already saw are left
 * out. Null when nothing shows.
 * @param {number} [now]
 * @param {number} [advisedAt]
 */
export function stripView(activities, now = Date.now(), advisedAt) {
  const showing = (Array.isArray(activities) ? activities : [])
    .filter((a) => shows(a, now) && !advised(a, advisedAt))
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
