/**
 * Page routes. The workspace lives at `/` (its view state stays in the hash);
 * settings and analytics are pages, global or per project:
 *   /settings/:section                 /analytics
 *   /projects/:id/settings/:section    /projects/:id/analytics
 */

import { signal } from './lib.js';

/**
 * Settings sections in nav order: [id, label, group?, comingSoon?]. A group heads the sections under
 * it in the nav; a coming-soon section says so instead of showing controls.
 */
export const FOUNDRY_SETTINGS = [
  ['profile', 'Profile'],
  ['providers', 'Providers'],
  ['kingdom', 'Kingdom', 'Integrations'],
  ['archive', 'Archive', 'Integrations'],
  ['github', 'GitHub', 'Integrations'],
  ['linear', 'Linear', 'Integrations'],
  ['devices', 'Devices'],
  ['layers', 'Layers', 'Advanced'],
  ['agents', 'Agents', 'Advanced'],
  ['activity', 'Activity', 'Advanced'],
  ['feedback', 'Feedback', 'Advanced'],
];

export const PROJECT_SETTINGS = [
  ['integrations', 'Integrations'],
  ['chorus', 'Chorus'],
  ['archive', 'Archive'],
  ['sources', 'Sources'],
  ['gloss', 'Gloss', null, true],
  ['overrides', 'Overrides', null, true],
];

/** Section addresses that moved: an old link lands on the section that now holds it. */
const MOVED_SECTIONS = { models: 'providers', tunnel: 'devices', integrations: 'kingdom' };

/** { page: 'workspace' | 'settings' | 'analytics', projectId: string | null, section?: string } */
export function parseRoute(pathname) {
  let parts;
  try {
    parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { page: 'workspace', projectId: null };
  }
  const projectId = parts[0] === 'projects' && parts[1] ? parts[1] : null;
  const rest = projectId ? parts.slice(2) : parts;
  if (rest[0] === 'analytics') return { page: 'analytics', projectId };
  if (rest[0] === 'settings') {
    const sections = projectId ? PROJECT_SETTINGS : FOUNDRY_SETTINGS;
    const asked = projectId ? rest[1] : (MOVED_SECTIONS[rest[1]] ?? rest[1]);
    const section = sections.some(([id]) => id === asked) ? asked : sections[0][0];
    return { page: 'settings', projectId, section };
  }
  return { page: 'workspace', projectId: null };
}

export function settingsPath(projectId, section) {
  const base = projectId ? `/projects/${encodeURIComponent(projectId)}/settings` : '/settings';
  return section ? `${base}/${section}` : base;
}

export function analyticsPath(projectId) {
  return projectId ? `/projects/${encodeURIComponent(projectId)}/analytics` : '/analytics';
}

/** The one address of a parsed route; settings always name their section. */
function routePath(next) {
  if (next.page === 'settings') return settingsPath(next.projectId, next.section);
  if (next.page === 'analytics') return analyticsPath(next.projectId);
  return '/';
}

export const route = signal(parseRoute(location.pathname));
if (route.value.page !== 'workspace') history.replaceState(null, '', routePath(route.value));

/** Leaving the workspace keeps its hash so returning restores the same view. */
let workspaceHash = route.value.page === 'workspace' ? location.hash : '';

export function navigate(path) {
  if (route.value.page === 'workspace') workspaceHash = location.hash;
  const next = parseRoute(new URL(path, location.origin).pathname);
  const url = next.page === 'workspace' ? `/${workspaceHash}` : routePath(next);
  if (url !== location.pathname + location.hash) history.pushState(null, '', url);
  route.value = next;
}

/** Internal links navigate in place; modified clicks still open a new tab. */
export function onLink(event) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute('href'));
}

// Hash-only changes (the workspace's own view state) also fire popstate; they leave the page as is.
window.addEventListener('popstate', () => {
  const next = parseRoute(location.pathname);
  const current = route.value;
  if (
    next.page !== current.page ||
    next.projectId !== current.projectId ||
    next.section !== current.section
  )
    route.value = next;
});
