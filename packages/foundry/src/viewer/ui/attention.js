/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * One "needs you" definition everywhere (design review 11-02): per top-level thread, red (can't
 * proceed) over orange (needs you) over its own colour. Shown as an orange count and a red count side
 * by side, never one mixed number: the rail's pane heads, the top bar's Open pill and the Board button
 * all read it. A top-level thread's colour is its own: a subagent's failures and answers go to the
 * agent that spawned it, not to you (Aron, 11-14). A subagent that does need you raises its approval
 * or question on the top-level thread's own id (the tool gate is bound to the session), so that
 * thread turns orange by itself.
 */
import { html } from './lib.js';
import { allThreads } from './store.js';
import { categoryOf, isClosedThread, isScheduledRun } from './thread-status.js';
import { nodeState, threadTree } from './thread-tree.js';

/** A root's colour category: its own; subagents never add to it. */
export const effectiveCategory = (node) => categoryOf(nodeState(node));

/** Open top-level threads (subagents fold into their parent), scheduled runs included. */
export const openRoots = () => threadTree(allThreads.value.filter((t) => !isClosedThread(t)));

/** Open's threads: open top-level threads that are not a schedule's run (those live under Scheduled). */
export const openListRoots = () => openRoots().filter((node) => !isScheduledRun(node));

/** Does this node need the owner (red or orange)? */
export const needsOwner = (node) => ['problem', 'attention'].includes(effectiveCategory(node));

/** { needs, red } over top-level nodes. */
export function attentionOf(nodes) {
  const cats = nodes.map(effectiveCategory);
  return {
    needs: cats.filter((c) => c === 'attention').length,
    red: cats.filter((c) => c === 'problem').length,
  };
}

/** Orange and red counts side by side; nothing when neither. */
export function Attention({ nodes }) {
  const { needs, red } = attentionOf(nodes);
  if (!needs && !red) return null;
  const tip = [
    needs ? `${needs} need${needs === 1 ? 's' : ''} you` : '',
    red ? `${red} can't proceed` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return html`<span class="rail-attn" title=${tip} aria-label=${tip}>${needs ? html`<span class="rail-attn-needs">${needs}</span>` : null}${red ? html`<span class="rail-attn-red">${red}</span>` : null}</span>`;
}
