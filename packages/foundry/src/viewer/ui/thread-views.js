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
 * One grouped control, `/thread · /btw · /aside`: each segment shows or hides its view, and two or
 * more on sit side by side. Remembered in this browser, as dev mode and read-aloud are. The composer
 * always says which room it sends to.
 *
 * Asides and /btw records arrive with the shared-thread data (inixiative-da's slice 2b); until the
 * conversation view carries them, those views say so in one line.
 */

import { html, signal } from './lib.js';

const OPEN_VIEWS = 'foundry.thread.views';
const VIEW_IDS = ['thread', 'btw', 'asides'];

const readViews = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_VIEWS) ?? '[]');
    const views = VIEW_IDS.filter((id) => Array.isArray(saved) && saved.includes(id));
    return views.length ? views : ['thread'];
  } catch {
    return ['thread'];
  }
};

/** The views showing, in order; more than one shows them side by side. Never empty. */
export const openViews = signal(readViews());

/** One segment toggles its view; turning the last one off leaves the thread. */
export function toggleView(id) {
  const on = openViews.value.includes(id);
  const next = VIEW_IDS.filter((v) => (v === id ? !on : openViews.value.includes(v)));
  openViews.value = next.length ? next : ['thread'];
  try {
    localStorage.setItem(OPEN_VIEWS, JSON.stringify(openViews.value));
  } catch {
    /* this browser keeps no settings; the control still works for the page */
  }
}

const SEGMENTS = [
  ['thread', '/thread'],
  ['btw', '/btw'],
  ['asides', '/aside'],
];

/**
 * One grouped control, styled as the centre's view switcher: each segment shows or hides its view
 * (filled when on), and two or more on sit side by side.
 */
export function ThreadViewSegments({ conversation }) {
  return html`<div class="thread-views-bar">
    <div class="thread-segments band-tabs" role="group" aria-label="Thread views">
      ${SEGMENTS.map(([id, label]) => {
        const on = openViews.value.includes(id);
        return html`<button key=${id} aria-pressed=${on}
          class="thread-segment center-view ${on ? 'center-view--active' : ''}"
          onClick=${() => toggleView(id)}>${label}</button>`;
      })}
    </div>
  </div>`;
}

/** "N asides since your last post", so a decision made in an aside isn't missed. */
export function AsidesSince({ conversation }) {
  const count = conversation?.asidesSinceYourPost ?? 0;
  if (!count) return null;
  return html`<button class="asides-since" onClick=${() => {
    if (!openViews.value.includes('asides')) toggleView('asides');
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
