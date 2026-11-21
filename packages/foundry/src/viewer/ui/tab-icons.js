/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * The right panel's tab icons, shown at every size: beside the label when the panel is open, alone
 * in the icons strip. Work is a briefcase (it holds the thread's file changes, commits and pull requests).
 */

import { safeCall } from './error-boundary.js';
import { html } from './lib.js';

const PATHS = {
  // lucide list-checks: the plan's outcomes
  plan: html`<path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8M13 12h8M13 18h8" />`,
  // lucide repeat: rounds of build, check and fix
  loop: html`<path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />`,
  // lucide shapes: what the agent made to show you
  artifacts: html`<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" /><rect x="3" y="14" width="7" height="7" rx="1" /><circle cx="17.5" cy="17.5" r="3.5" />`,
  // lucide briefcase
  work: html`<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /><rect x="2" y="6" width="20" height="14" rx="2" />`,
  // a page: what the thread runs on and links to
  context: html`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M8 13h8M8 17h5" />`,
  // lucide users
  participants: html`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />`,
  // lucide key-round
  permissions: html`<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" />`,
  // lucide megaphone: Heralds carry what others are doing
  heralds: html`<path d="m3 11 18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />`,
  // a dagger: the Wardens' pointers into the docs
  pointers: html`<path d="M12 2v20" /><path d="M7 7h10" />`,
  // lucide message-square-text
  feedback: html`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M13 8H7M17 12H7" />`,
  // Left-rail built-ins (used when moved to the right panel / collapsed 44px strip)
  // lucide bell: Attention (threads needing your decision or answer)
  attention: html`<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />`,
  // lucide inbox: Open threads across projects
  open: html`<polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />`,
  // lucide folder: Projects and their threads
  projects: html`<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />`,
  // lucide clock: Scheduled runs, schedules, and loops
  scheduled: html`<circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />`,
  // lucide activity: Machine status and resources
  status: html`<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />`,
};

const FALLBACK_PATH = html`<rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />`;

export function TabIcon({ tab, icon, extId }) {
  if (icon) {
    if (typeof icon === 'string') {
      if (PATHS[icon]) {
        return html`<svg class="tab-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[icon]}</svg>`;
      }
      return html`<span class="tab-icon tab-icon--glyph" aria-hidden="true">${icon}</span>`;
    }
    if (typeof icon === 'function') {
      const rendered = extId ? safeCall(extId, () => icon(), null, 'rightTab.icon') : icon();
      if (rendered !== null && rendered !== undefined && rendered !== false) return rendered;
    } else {
      return icon;
    }
  }
  const path = PATHS[tab] ?? FALLBACK_PATH;
  return html`<svg class="tab-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
