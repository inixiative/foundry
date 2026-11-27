/**
 * @atlas
 * @kind route
 * @partOf feature:viewer, feature:wardens
 */
import type { Hono } from 'hono';
import type { ProjectHostState } from '../../providers/project-warden-hosts';
import { type ConfigStore, devModeOn } from '../config';
import { type WardenHealthInput, wardenHostHealth } from '../warden-host-health';

export interface WardenHostHealthRouteDeps {
  readonly configStore: ConfigStore;
  /** The Warden hosts' snapshot, local and remote (`decisionHosts`). */
  readonly hosts?: () => { projects: Record<string, ProjectHostState> } | undefined;
  /** Ask a project's remote Chorus how it stands now (`chorusRemotes.check`); local hosts are live already. */
  readonly check?: (projectId: string) => Promise<void>;
}

/**
 * `GET /api/warden-hosts/health[?project=<id>][&fresh=1]`: every project's Layer 1 and Layer 2 health
 * (`viewer/warden-host-health.ts`). `fresh=1` asks each remote Chorus first instead of the last poll's
 * answer. 200 with `ok` saying whether every chorus is healthy (`foundry doctor --chorus`); 404 for
 * a `project` this Foundry does not have.
 */
export function registerWardenHostHealthRoutes(app: Hono, deps: WardenHostHealthRouteDeps) {
  app.get('/api/warden-hosts/health', async (c) => {
    await deps.configStore.load();
    const config = deps.configStore.config;
    const only = c.req.query('project');
    if (only && !config.projects?.[only]) return c.json({ error: `No project ${only}` }, 404);
    const ids = Object.keys(config.projects ?? {}).filter((id) => !only || id === only);
    const projects = ids.map((projectId): WardenHealthInput => {
      const chorus = deps.configStore.resolveProjectView(projectId)?.chorus;
      const on = chorus?.on === true;
      return {
        projectId,
        label: config.projects[projectId]?.label ?? projectId,
        on,
        devMode: devModeOn(config, projectId),
        ...(chorus?.reason ? { reason: chorus.reason } : {}),
      };
    });
    if (c.req.query('fresh') === '1' && deps.check) {
      const check = deps.check;
      await Promise.all(
        projects.filter((project) => project.on).map((project) => check(project.projectId)),
      );
    }
    return c.json(wardenHostHealth(projects, deps.hosts?.()?.projects));
  });
}
