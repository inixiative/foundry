/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Where a thread moved to another worker or model mid-conversation: a "Continued on Codex from here"
 * or "Switched to claude-opus-5-6 from here" line in the transcript, at the point it switched (the
 * launch view's `switches`, from the journal's `worker-switch` rows). On a new worker the session
 * started fresh, seeded with the conversation; a model switch on the same worker kept its session.
 */

import { html } from './lib.js';
import { workerName } from './run-picker.js';

/**
 * The thread's messages (each with its own index), each switch before the first message after it.
 * A switch older than the loaded page shows only once the page reaches back to it (`hasOlder` false
 * or a message before it is loaded); one after the last message goes at the end.
 */
export function withSwitchMarkers(messages, switches, hasOlder) {
  if (!switches?.length) return messages.map((msg, index) => ({ msg, index }));
  const time = (msg) => new Date(msg.timestamp).getTime() || 0;
  const first = messages.length ? time(messages[0]) : Infinity;
  const pending = switches.filter((s) => !hasOlder || s.at >= first).sort((a, b) => a.at - b.at);
  const out = [];
  let next = 0;
  messages.forEach((msg, index) => {
    while (next < pending.length && pending[next].at <= time(msg))
      out.push({ marker: pending[next++] });
    out.push({ msg, index });
  });
  while (next < pending.length) out.push({ marker: pending[next++] });
  return out;
}

export function WorkerSwitchMarker({ marker }) {
  const to = workerName(marker.to) ?? marker.toLabel;
  const from = workerName(marker.from) ?? marker.fromLabel;
  const when = new Date(marker.at).toLocaleString();
  const why = marker.cause === 'retired' ? ` because ${marker.fromModel} was retired` : '';
  if (marker.from === marker.to)
    return html`<div class="worker-switch-marker" role="note" data-switch-model=${marker.toModel}
      title=${`Switched from ${marker.fromModel ?? 'its earlier model'} on ${when}${why}. The same session continues.`}>
      <span>Switched to ${marker.toModel} from here${why}</span>
    </div>`;
  return html`<div class="worker-switch-marker" role="note" data-switch-to=${marker.to}
    title=${`Moved from ${from} on ${when}${why}. The new session carries the conversation and plan, not the old session's files read or tool state.`}>
    <span>Continued on ${to}${marker.toModel ? ` with ${marker.toModel}` : ''} from here</span>
  </div>`;
}
