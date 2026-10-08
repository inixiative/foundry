/**
 * Page routes. The workspace lives at `/` (its view state stays in the hash);
 * settings and analytics are pages, global or per project:
 *   /settings/:section                 /analytics
 *   /projects/:id/settings/:section    /projects/:id/analytics
 */

import { signal } from './lib.js';

export const FOUNDRY_SETTINGS = [
  ['models', 'Models'],
  ['providers', 'Providers'],
  ['kingdom', 'Kingdom'],
  ['integrations', 'Integrations'],
  ['archive', 'Archive'],
  ['tunnel', 'Tunnel'],
  ['devices', 'Devices'],
];

export const PROJECT_SETTINGS = [
  ['integrations', 'Integrations'],
  ['archive', 'Archive'],
  ['sources', 'Sources'],
  ['gloss', 'Gloss'],
  ['overrides', 'Overrides'],
];

/** { page: 'workspace' | 'settings' | 'analytics', projectId: string | null, section?: string } */
export function parseRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const projectId = parts[0] === 'projects' && parts[1] ? parts[1] : null;
  const rest = projectId ? parts.slice(2) : parts;
  if (rest[0] === 'analytics') return { page: 'analytics', projectId };
  if (rest[0] === 'settings') {
    const sections = projectId ? PROJECT_SETTINGS : FOUNDRY_SETTINGS;
    const section = sections.some(([id]) => id === rest[1]) ? rest[1] : sections[0][0];
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
  history.pushState(null, '', next.page === 'workspace' ? `/${workspaceHash}` : routePath(next));
  route.value = next;
}

/** Internal links navigate in place; modified clicks still open a new tab. */
export function onLink(event) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute('href'));
}

window.addEventListener('popstate', () => {
  route.value = parseRoute(location.pathname);
});
