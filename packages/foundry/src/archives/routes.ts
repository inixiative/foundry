import type { ArchiveSnapshot } from '@inixiative/archive';
import { type ArchiveClient, ArchiveRequestError, localArchive } from '@inixiative/archive/remote';
import type { EventStream } from '@inixiative/foundry-core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { LocalSessionStore } from '../persistence/local-session-store';
import { ArchiveCapture } from './capture';
import { type ArchiveConnector, archiveStatus, startLocalArchive } from './local';
import { runArchiveSetup } from './setup';

/** Foundry's view of this machine's Archive: capture into it, browse and search it, set it up. */
export function registerArchiveRoutes(
  app: Hono,
  journal: LocalSessionStore,
  events: EventStream,
  /** Each captured thread snapshot, e.g. to derive the thread's linked work. */
  observe?: (snapshot: ArchiveSnapshot) => void,
  options: { connect?: ArchiveConnector; up?: () => Promise<void> } = {},
) {
  const { connect = () => localArchive(), up = startLocalArchive } = options;
  // Resolved until found, so an Archive set up while Foundry runs is picked up on the next retry.
  let client: ArchiveClient | undefined;
  const archive = () => (client ??= connect());
  const capture = new ArchiveCapture(journal, archive, events, observe);
  app.use('/api/archives/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/api/archives/status', async (c) => c.json(await archiveStatus(archive())));
  app.post('/api/archives/setup', async (c) => {
    const result = await runArchiveSetup({ connect, up, log: () => {} });
    client = undefined;
    for (const thread of journal.threads()) capture.schedule(thread.id);
    return c.json(result, result.error ? 502 : 200);
  });
  app.get('/api/archives', async (c) => {
    const local = archive();
    const status = await archiveStatus(local);
    const projectId = c.req.query('projectId');
    const archives =
      local && status.reachable
        ? await local.list(projectId ? { projectId } : {}).catch(() => [])
        : [];
    return c.json({ archives, captureErrors: Object.fromEntries(capture.errors), status });
  });
  // Where a project's sessions publish. Archive owns the routing; Foundry only reads and asks.
  app.get('/api/archives/destinations', async (c) => {
    const projectId = c.req.query('projectId');
    const local = archive();
    if (!local) return c.json({ error: 'No local Archive is set up' }, 503);
    try {
      const [{ destinations }, { paired, libraries }] = await Promise.all([
        local.destinations(projectId ? { projectId } : {}),
        local.libraries(),
      ]);
      return c.json({ destinations, paired, libraries });
    } catch (error) {
      return archiveFailure(c, error);
    }
  });
  const kingdomRoute = z.strictObject({
    projectId: z.string().min(1).max(256),
    integrationId: z.uuid(),
    resourceId: z.uuid(),
  });
  for (const action of ['connect', 'remove'] as const)
    app.post(`/api/archives/destinations/${action}`, async (c) => {
      const body = kingdomRoute.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: 'Invalid destination' }, 400);
      const local = archive();
      if (!local) return c.json({ error: 'No local Archive is set up' }, 503);
      try {
        return c.json(
          action === 'connect'
            ? await local.connectDestination(body.data)
            : await local.removeDestination(body.data),
        );
      } catch (error) {
        return archiveFailure(c, error);
      }
    });
  app.get('/api/archives/:id', async (c) => {
    const found = await archive()
      ?.read(c.req.param('id'))
      .catch(() => undefined);
    return found ? c.json(found) : c.json({ error: 'Archive unavailable' }, 404);
  });
  app.post('/api/archives/search', async (c) => {
    const body = z
      .strictObject({
        query: z.string().max(1000).default(''),
        projectId: z.string().min(1).max(256).optional(),
        budget: z.number().int().min(16).max(32768).default(2048),
        limit: z.number().int().min(1).max(100).default(20),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'Invalid archive query' }, 400);
    const local = archive();
    if (!local) return c.json({ error: 'No local Archive is set up' }, 503);
    try {
      return c.json(await local.search(body.data));
    } catch {
      return c.json({ error: 'Archive unavailable' }, 502);
    }
  });
  app.post('/api/archives/capture', (c) => {
    for (const thread of journal.threads()) capture.schedule(thread.id);
    return c.json({ queued: true });
  });
  return { capture };
}

/** Archive's refusals (e.g. a library the Signet does not grant) pass through; anything else is unavailability. */
function archiveFailure(c: Context, error: unknown) {
  if (error instanceof ArchiveRequestError && error.status >= 400 && error.status < 500)
    return c.json({ error: error.message }, error.status as 400 | 403 | 404 | 409);
  return c.json({ error: 'Archive unavailable' }, 502);
}
