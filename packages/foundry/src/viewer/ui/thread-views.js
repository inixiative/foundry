/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The Thread tab's three views (Oracle ATTENTION-BOARD.md §4.9 6a, Aron 2026-11-01):
 *   Thread  the log everyone in it reads
 *   /btw    you and your own agent, privately; it never enters the thread
 *   Asides  people only, every other human in the thread, never an agent; one action promotes one
 * Tabs by default; "Side by side" shows all three as columns. The setting is remembered in this
 * browser, as dev mode and read-aloud are. The composer always says which room it sends to.
 *
 * Asides and /btw records arrive with the shared-thread data (inixiative-da's slice 2b); until the
 * conversation view carries them, those views say so in one line.
 */

import { html, signal } from './lib.js';
import { Switch } from './switch.js';

const SIDE_BY_SIDE = 'foundry.thread.sideBySide';

const readFlag = (key) => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

/** Which view the Thread tab shows when they are tabs: 'thread' | 'btw' | 'asides'. */
export const threadView = signal('thread');
export const sideBySide = signal(readFlag(SIDE_BY_SIDE));
/** Where the composer sends: 'thread' | 'btw' | 'aside'. */
export const composerChannel = signal('thread');

export function setSideBySide(on) {
  sideBySide.value = on;
  try {
    if (on) localStorage.setItem(SIDE_BY_SIDE, '1');
    else localStorage.removeItem(SIDE_BY_SIDE);
  } catch {
    /* this browser keeps no settings; the switch still works for the page */
  }
}

const VIEWS = [
  ['thread', 'Thread'],
  ['btw', '/btw'],
  ['asides', 'Asides'],
];

/** Counts of what is new in each view, from the conversation view when it carries them. */
function unreadOf(conversation) {
  return {
    btw: conversation?.btwUnread ?? 0,
    asides: conversation?.asideUnread ?? 0,
  };
}

export function ThreadViewTabs({ conversation }) {
  const unread = unreadOf(conversation);
  return html`<div class="thread-views-bar">
    ${
      sideBySide.value
        ? html`<span class="thread-views-label">Thread · /btw · Asides</span>`
        : html`<div class="thread-views-tabs" role="tablist" aria-label="Thread views">
            ${VIEWS.map(
              ([
                id,
                label,
              ]) => html`<button key=${id} role="tab" aria-selected=${threadView.value === id}
                class="thread-view-tab ${threadView.value === id ? 'is-active' : ''}"
                onClick=${() => {
                  threadView.value = id;
                }}>${label}${unread[id] ? html`<span class="thread-view-unread">${unread[id]}</span>` : null}</button>`,
            )}
          </div>`
    }
    <label class="thread-views-side">
      <${Switch} checked=${sideBySide.value} label="Side by side" onChange=${setSideBySide} />
      Side by side
    </label>
  </div>`;
}

/** "N asides since your last post", so a decision made in an aside isn't missed. */
export function AsidesSince({ conversation }) {
  const count = conversation?.asidesSinceYourPost ?? 0;
  if (!count) return null;
  return html`<button class="asides-since" onClick=${() => {
    threadView.value = 'asides';
  }}>${count} aside${count === 1 ? '' : 's'} since your last post →</button>`;
}

/** Your private questions to your own agent and its answers; nothing here enters the thread. */
export function BtwView({ entries }) {
  return html`<section class="side-view side-view--btw" aria-label="/btw">
    <h3 class="side-view-title">/btw <span class="side-view-hint">you and your agent, privately</span></h3>
    ${
      entries?.length
        ? entries.map(
            (e) => html`<article key=${e.id} class="btw-entry">
              <p class="btw-q">${e.question}</p>
              ${e.answer ? html`<p class="btw-a">${e.answer}</p>` : html`<p class="btw-a btw-a--pending">Answering…</p>`}
            </article>`,
          )
        : html`<p class="side-view-empty">Ask your own agent something with /btw; it answers here and nothing enters the thread. Arrives with shared-thread asides.</p>`
    }
  </section>`;
}

/** Asides between the people in the thread; one action promotes an aside into the thread. */
export function AsidesView({ entries, onPromote }) {
  return html`<section class="side-view side-view--asides" aria-label="Asides">
    <h3 class="side-view-title">Asides <span class="side-view-hint">people only, never an agent</span></h3>
    ${
      entries?.length
        ? entries.map(
            (e) => html`<article key=${e.id} class="aside-card">
              <div class="aside-card-head"><span class="aside-card-kind">by the way</span><span class="aside-card-who">${e.member?.name ?? 'Someone'}</span></div>
              <p class="aside-card-text">${e.text}</p>
              ${onPromote ? html`<button class="rp-link" onClick=${() => onPromote(e)}>Promote to the thread</button>` : null}
            </article>`,
          )
        : html`<p class="side-view-empty">Asides between the people in this thread show here. Arrives with shared-thread asides.</p>`
    }
  </section>`;
}

const CHANNELS = [
  ['thread', 'Thread'],
  ['btw', '/btw'],
  ['aside', 'Aside'],
];

/** Who reads what you send on each channel. */
export function sendingTo(channel, people) {
  if (channel === 'btw') return 'Sending to your own agent, privately: it never enters the thread';
  if (channel === 'aside')
    return 'Sending an aside to the other people in this thread: no agent reads it';
  return people > 1
    ? 'Sending to the thread: everyone in it and their agents read it'
    : 'Sending to the thread';
}

/** The composer's channel picker and its "Sending to …" line. Aside needs another person in the thread. */
export function ChannelPicker({ people }) {
  const channel = composerChannel.value;
  return html`<div class="channel-picker channel-picker--${channel}">
    <div class="channel-tabs" role="radiogroup" aria-label="Send to">
      ${CHANNELS.map(([id, label]) => {
        const off = id === 'aside' && people < 2;
        return html`<button key=${id} role="radio" aria-checked=${channel === id} disabled=${off}
          title=${off ? 'No other people in this thread' : label}
          class="channel-tab ${channel === id ? 'is-active' : ''}"
          onClick=${() => {
            composerChannel.value = id;
          }}>${label}</button>`;
      })}
    </div>
    <span class="channel-sending" role="status">${sendingTo(channel, people)}</span>
  </div>`;
}
