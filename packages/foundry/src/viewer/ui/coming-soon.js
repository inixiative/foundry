/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * A surface we intend to build, shown as such instead of as an empty panel: a "Coming soon" badge and
 * one line on what it will show. With a ticket, the badge itself links to the ticket that plans it
 * (Aron 11-02: no separate ticket link or id).
 */

import { html } from './lib.js';

export const REPO_URL = 'https://github.com/inixiative/foundry';

/** Ticket id → its file under `tickets/` in the Foundry repo. */
const TICKETS = {
  'AGENT-001': 'AGENT-001-herald-cross-thread',
  'BOARD-003': 'BOARD-003-inbound-items',
  'VIEWER-004': 'VIEWER-004-gloss-viewer',
  'VIEWER-007': 'VIEWER-007-your-other-machines',
};

export const ticketUrl = (id) => `${REPO_URL}/blob/main/tickets/${TICKETS[id]}.md`;

/** The "Coming soon" badge; with a ticket, a link to its plan. */
export function SoonBadge({ ticket, children = 'Coming soon' }) {
  return ticket
    ? html`<a class="coming-soon is-link" href=${ticketUrl(ticket)} target="_blank" rel="noreferrer"
        title="The plan for this, in the Foundry repo">${children}</a>`
    : html`<span class="coming-soon">${children}</span>`;
}

/**
 * `inline` renders inside a line of text (a sidebar note, a search group); `card` as a settings
 * section of its own; otherwise a block.
 */
export function ComingSoon({ what, ticket, inline = false, card = false }) {
  const body = html`<${SoonBadge} ticket=${ticket} />
    <span class="coming-soon-what">${what}</span>`;
  if (card)
    return html`<section class="settings-card coming-soon-card"><${SoonBadge} ticket=${ticket} /><p class="settings-desc">${what}</p></section>`;
  return inline
    ? html`<span class="coming-soon-note is-inline">${body}</span>`
    : html`<div class="coming-soon-note">${body}</div>`;
}
