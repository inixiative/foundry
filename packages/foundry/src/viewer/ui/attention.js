/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * One "needs you" definition everywhere (design review 11-02): per top-level thread, its subagents'
 * states bubble up, red (can't proceed) over orange (needs you). Shown as an orange count and a red
 * count side by side, never one mixed number: the rail's pane heads, the top bar's Open pill and the
 * Board button all read it.
 */
import { html } from './lib.js';
import { allThreads } from './store.js';
import { categoryOf, isClosedThread } from './thread-status.js';
import { nodeState, threadTree } from './thread-tree.js';

/** A root's colour category, its subagents' bubbling up: red over orange over its own. */
export function effectiveCategory(node) {
  const cats = [];
  const walk = (n) => {
    cats.push(categoryOf(nodeState(n)));
    for (const c of n.children) walk(c);
  };
  walk(node);
  if (cats.includes('problem')) return 'problem';
  if (cats.includes('attention')) return 'attention';
  return cats[0];
}

/** Open top-level threads (subagents fold into their parent). */
export const openRoots = () => threadTree(allThreads.value.filter((t) => !isClosedThread(t)));

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
