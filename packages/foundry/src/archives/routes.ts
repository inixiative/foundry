import type { ArchiveSnapshot } from '@inixiative/archive';
import { type ArchiveClient, localArchive } from '@inixiative/archive/remote';
import type { EventStream } from '@inixiative/foundry-core';
import type { Hono } from 'hono';
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
