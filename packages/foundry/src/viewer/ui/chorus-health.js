/**
 * @atlas
 * @kind component
 * @partOf feature:viewer, feature:wardens
 */
/**
 * A degraded chorus in words (FEAT-008). Pure: reads the `chorus` the message index puts on an agent
 * row (`TurnChorus`: every degraded row of the turn, and which are still open) and says which Wardens
 * went unheard, at which layer, and why. The turn went on without them; Retry asks them again, from
 * the one prompt in the strip above the composer.
 */

const KIND = { timeout: 'timed out', error: 'failed', 'not-started': 'not started' };

/** One Warden in words: "security (Layer 1 timed out)". */
export function wardenLine(warden) {
  const layer = typeof warden.layer === 'number' ? `Layer ${warden.layer} ` : '';
  const spoke = warden.silent === false ? '; spoke from Layer 1 only, unconfirmed' : '';
  return `${warden.domain} (${layer}${KIND[warden.kind] ?? 'failed'}${spoke})`;
}

const MOMENT = {
  'user-message': 'on the message',
  'agent-action': "on the turn's actions",
  'subagent-spawn': 'on a handoff',
  consumed: 'on a work item',
  milestone: 'on a milestone',
  'hand-back': 'on a hand-back',
};

/**
 * The notice for one turn while it is still degraded (`open`: the strip above the composer offers Retry
 * and Dismiss), or null when nothing is shown (never degraded, asked again, or dismissed).
 */
export function chorusNotice(chorus) {
  const notices = Array.isArray(chorus?.notices) ? chorus.notices : [];
  const open = new Set(Array.isArray(chorus?.open) ? chorus.open : []);
  const still = notices.filter((n) => open.has(n.rowId));
  if (still.length) {
    const parts = still.map((n) =>
      `${MOMENT[n.trigger] ?? ''} ${n.degraded.map(wardenLine).join(', ')}`.trim(),
    );
    const wardens = new Set(still.flatMap((n) => n.degraded.map((d) => d.domain)));
    const silent = still.some((n) => n.degraded.some((d) => d.silent !== false));
    return {
      state: 'open',
      count: wardens.size,
      text: `Some Wardens went unheard on this turn: ${parts.join('; ')}. The turn went on without ${silent ? 'them' : 'their confirmation'}.`,
    };
  }
  return null;
}

/**
 * The newest degraded agent turn, while it is still open (the strip's notice). A clean turn carries no
 * chorus and is passed over, so an open turn stays shown after clean ones; once the newest degraded
 * turn is asked again or dismissed, older ones are reached from their turn view.
 */
export function lastDegraded(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (message?.actor !== 'agent' || !message.chorus) continue;
    return chorusNotice(message.chorus)?.state === 'open' ? message : null;
  }
  return null;
}
