/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * A surface we intend to build, shown as such instead of as an empty panel: a "Coming soon" badge,
 * one line on what it will show, and a link to the ticket that plans it when there is one.
 */

import { html } from './lib.js';

export const REPO_URL = 'https://github.com/inixiative/foundry';

/** Ticket id → its file under `tickets/` in the Foundry repo. */
const TICKETS = {
  'AGENT-001': 'AGENT-001-herald-cross-thread',
  'BOARD-003': 'BOARD-003-inbound-items',
};

export const ticketUrl = (id) => `${REPO_URL}/blob/main/tickets/${TICKETS[id]}.md`;

/** `inline` renders inside a line of text (a sidebar note, a search group); otherwise a block. */
export function ComingSoon({ what, ticket, inline = false }) {
  const body = html`<span class="coming-soon">Coming soon</span>
    <span class="coming-soon-what">${what}</span>
    ${
      ticket
        ? html`<a class="coming-soon-link" href=${ticketUrl(ticket)} target="_blank" rel="noreferrer"
          title="The plan for this, in the Foundry repo">${ticket} ↗</a>`
        : null
    }`;
  return inline
    ? html`<span class="coming-soon-note is-inline">${body}</span>`
    : html`<div class="coming-soon-note">${body}</div>`;
}
