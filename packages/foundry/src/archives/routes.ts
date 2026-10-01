import type { Hono } from 'hono';
import { join } from 'node:path';
import { z } from 'zod';
import type { EventStream } from '@inixiative/foundry-core';
import { LocalArchiveStore } from '@inixiative/session-archive/local';
import type { LocalSessionStore } from '../persistence/local-session-store';
import { type ArchiveDestination, readDestinations } from './config';
import { FoundryCredentials } from '../providers/credentials';
import { ConfigStore } from '../viewer/config';
import { ArchiveContextSource } from './context-source';
import { ArchiveCapture } from './capture';
import {
  publishArchive,
  archiveRequest,
  kingdomFields,
  listKingdomConnections,
  saveArchiveConnection,
} from './publish';

export function registerArchiveRoutes(
  app: Hono,
  journal: LocalSessionStore,
  events: EventStream,
  configDir: string,
) {
  const credentials = new FoundryCredentials(
    configDir,
    async () => (await new ConfigStore(configDir).load()).kingdomRuntimes,
  );
  const configPath = join(configDir, 'archives.json');
  let destinations: ArchiveDestination[] = [];
  let configurationError: string | undefined;
  const loadDestinations = () => {
    try {
      destinations = readDestinations(configPath);
      configurationError = undefined;
    } catch {
      destinations = [];
      configurationError = `${configPath} is invalid, so no archives publish. Fix or remove it, then reconnect.`;
    }
  };
  loadDestinations();
  const store = new LocalArchiveStore(join(configDir, 'archives', 'archives.sqlite'));
  app.use('/api/archives/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  const publishing = new Set<string>();
  const republish = new Set<string>();
  const publicationErrors = new Map<string, string>();
  let stopped = false;
  const publish = async (id: string) => {
    if (stopped) return;
    if (publishing.has(id)) {
      republish.add(id);
      return;
    }
    publishing.add(id);
    try {
      const projectId = store.read(id)?.snapshot.projectId;
      let failed = false;
      for (const destination of destinations.filter((destination) => destination.projectId === projectId)) {
        try {
          await publishArchive(store, id, destination, fetch, credentials);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error('One or more archive destinations failed');
      publicationErrors.delete(id);
    } catch {
      publicationErrors.set(
        id,
        'Publication failed; local archive retained. Check destination access and retry.',
      );
    } finally {
      publishing.delete(id);
      if (republish.delete(id) && !stopped) void publish(id);
    }
  };
  const capture = new ArchiveCapture(journal, store, events, (id) => {
    void publish(id);
  });
  const retry = setInterval(() => {
    for (const id of publicationErrors.keys()) void publish(id);
  }, 30_000);
  retry.unref();
  journal.onClose(() => {
    stopped = true;
    clearInterval(retry);
  });
  for (const archive of store.list()) void publish(archive.id);
  app.get('/api/archives/kingdom', async (c) => {
    try {
      return c.json(
        await listKingdomConnections(credentials, c.req.query('kingdom'), fetch, journal.threads().length),
      );
    } catch {
      return c.json({ error: 'Pair the chosen Kingdom in Settings → Kingdom first.' }, 503);
    }
  });
  app.get('/api/archives/connections', async (c) =>
    c.json({
      configurationError,
      connections: await Promise.all(
        destinations.map(async (destination) => {
          try {
            await archiveRequest(
              destination,
              'search',
              {
                query: '',
                budget: 16,
                limit: 1,
                ...(destination.kind === 'archive'
                  ? { projectId: destination.projectId }
                  : kingdomFields(destination)),
              },
              fetch,
              credentials,
            );
            return { ...destination, status: 'connected' };
          } catch {
            return { ...destination, status: 'unavailable' };
          }
        }),
      ),
    }),
  );
  app.post('/api/archives/context', async (c) => {
    const parsed = z
      .strictObject({
        projectId: z.string().min(1),
        url: z.string(),
        connectionId: z.string().nullable().optional(),
        ownerModel: z.string().nullable().optional(),
        organizationId: z.string().nullable().optional(),
        spaceId: z.string().nullable().optional(),
        owner: z.string().nullable().optional(),
        query: z.string().max(1000).default(''),
      })
      .safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'Invalid Archive context request' }, 400);
    const matches = destinations.filter(
      (d) =>
        d.projectId === parsed.data.projectId &&
        d.url === parsed.data.url &&
        (['connectionId', 'ownerModel', 'organizationId', 'spaceId'] as const).every(
          (key) =>
            parsed.data[key] === undefined || (d.kind === 'archive' ? null : (d[key] ?? null)) === parsed.data[key],
        ) &&
        (parsed.data.owner === undefined ||
          (d.credential?.type === 'kingdom-runtime' ? d.credential.owner : null) === parsed.data.owner),
    );
    const destination = matches.length === 1 ? matches[0] : undefined;
    if (!destination) return c.json({ error: 'Archive connection unavailable' }, 404);
    try {
      const source = new ArchiveContextSource(
        'archive-preview',
        destination.url,
        {
          kind: destination.kind,
          projectId: destination.projectId,
          tokenEnv: destination.tokenEnv,
          credential: destination.credential,
          ...kingdomFields(destination),
          budget: 2048,
        },
        undefined,
        fetch,
        credentials,
      );
      return c.json({
        evidence: await source.bind({ projectId: destination.projectId }).load({ focus: parsed.data.query }),
      });
    } catch {
      return c.json({ error: 'Archive context unavailable' }, 502);
    }
  });
  app.post('/api/archives/connect', async (c) => {
    try {
      const configured = await saveArchiveConnection(configPath, await c.req.json(), credentials);
      loadDestinations();
      for (const archive of store.list())
        if (archive.projectId === configured.projectId) void publish(archive.id);
      return c.json({ ...configured, status: 'connected' });
    } catch {
      return c.json(
        {
          error: 'Connection failed. Check the destination and its Foundry credential or Kingdom enrollment.',
        },
        400,
      );
    }
  });
  app.get('/api/archives', (c) =>
    c.json({
      archives: store.list(),
      captureErrors: Object.fromEntries(capture.errors),
      publicationErrors: Object.fromEntries(publicationErrors),
      configurationError,
    }),
  );
  app.get('/api/archives/:id', (c) => {
    const archive = store.read(c.req.param('id'));
    return archive ? c.json(archive) : c.json({ error: 'Archive unavailable' }, 404);
  });
  app.post('/api/archives/search', async (c) => {
    const body = z
      .strictObject({
        ids: z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .min(1)
          .max(20),
        query: z.string().max(1000),
        budget: z.number().int().min(16).max(32768).default(2048),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'Invalid archive query' }, 400);
    try {
      return c.json({ results: store.search(body.data.ids, body.data.query, body.data.budget) });
    } catch {
      return c.json({ error: 'Archive unavailable' }, 404);
    }
  });
  app.post('/api/archives/capture', (c) => {
    for (const thread of journal.threads()) capture.schedule(thread.id);
    return c.json({ queued: true });
  });
  return { store, capture };
}
