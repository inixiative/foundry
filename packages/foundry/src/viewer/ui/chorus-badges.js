/**
 * @atlas
 * @kind component
 * @partOf feature:threadTree, feature:wardens
 */
/**
 * Beside the thread list's scope chip: the project's chorus as one dot, the worst state of its
 * Warden hosts (Layer 1 `project-wardens:<id>`, each Layer 2 lane `project-wardens:<id>:<lane>`, the
 * activity the status strip reads), and a `dev` badge while the project is in dev mode, amber when
 * a dev Chorus serving it is failed or degraded. Whether the chorus is on, dev mode and the serving Chorus come
 * from `/api/projects/:id/chorus`, re-read when the project's host activity changes. Nothing shows for
 * a project whose chorus is off and not in dev mode.
 */

import { html, useEffect, useState } from './lib.js';
import { authFetch, systemActivity } from './store.js';
import { RANK, STRIP_DOT } from './system-strip.js';

const isProjectHost = (activity, projectId) =>
  activity.key === `project-wardens:${projectId}` ||
  activity.key.startsWith(`project-wardens:${projectId}:`);

/** The worst state of the hosts; none open, or all resting, is idle. */
const worstState = (hosts) => {
  const ranked = hosts.filter((host) => host.state in RANK);
  if (!ranked.length) return 'idle';
  return ranked.reduce(
    (worst, host) => (RANK[host.state] < RANK[worst] ? host.state : worst),
    'ready',
  );
};

function useProjectChorus(projectId, activity) {
  const [chorus, setChorus] = useState(null);
  useEffect(() => {
    let live = true;
    authFetch(`/api/projects/${encodeURIComponent(projectId)}/chorus`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => live && setChorus(body))
      .catch(() => live && setChorus(null));
    return () => {
      live = false;
    };
  }, [projectId, activity]);
  return chorus;
}

const devTitle = (remote, failing) => {
  if (!remote) return 'Dev mode is on for this project.';
  if (failing) return `Dev mode: the dev Chorus at ${remote} is failed or degraded.`;
  return `Dev mode: Wardens run on the dev Chorus at ${remote}.`;
};

export function ChorusBadges({ projectId }) {
  const hosts = systemActivity.value.filter((activity) => isProjectHost(activity, projectId));
  const chorus = useProjectChorus(
    projectId,
    hosts.map((host) => `${host.key}=${host.state}`).join('|'),
  );
  const on = chorus?.chorus?.on === true;
  const dev = chorus?.dev?.on === true;
  if (!on && !dev) return null;
  const state = worstState(hosts);
  // A dev Chorus serves the project when the remote is a URL, not `kingdom:<host>`.
  const devRemote =
    dev && chorus.chorus.remote?.startsWith('http') ? chorus.chorus.remote : undefined;
  const failing = devRemote !== undefined && (state === 'failed' || state === 'degraded');
  const title = [
    ...hosts.map((host) => host.summary),
    chorus.chorus.remote ? `Served by ${chorus.chorus.remote}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return html`
    ${
      on
        ? html`<span class="system-strip-dot sidebar-chorus-dot" data-tone=${STRIP_DOT[state]}
            role="img" aria-label=${`Chorus ${state}`} title=${title || 'Chorus resting'}></span>`
        : null
    }
    ${
      dev
        ? html`<span class="chorus-dev-badge ${failing ? 'chorus-dev-badge--failing' : ''}"
            title=${devTitle(devRemote, failing)}>dev</span>`
        : null
    }
  `;
}
