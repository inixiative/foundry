import type { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { EventStream } from '@inixiative/foundry-core';
import { LocalArchiveStore } from '@inixiative/session-archive/local';
import type { LocalSessionStore } from '../persistence/local-session-store';
import { connectDestination } from './config';
import { FoundryCredentials } from '../providers/credentials';
import type { CredentialReference } from '@inixiative/foundry-core';
import { ConfigStore } from '../viewer/config';
import { ArchiveContextSource } from './context-source';
import { ArchiveCapture } from './capture';
import {
  archiveDestinationSchema,
  publishArchive,
  archiveRequest,
  verifyArchiveDestination,
} from './publish';

export function registerArchiveRoutes(
  app: Hono,
  journal: LocalSessionStore,
  events: EventStream,
  configDir: string,
) {
  const credentials = new FoundryCredentials(
    configDir,
    async () => (await new ConfigStore(configDir).load()).kingdomRuntime,
  );
  const configPath = join(configDir, 'archives.json');
  let destinations = existsSync(configPath)
    ? z
        .array(archiveDestinationSchema)
        .max(100)
        .parse(JSON.parse(readFileSync(configPath, 'utf8')))
    : [];
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
      const identity = await credentials.kingdomIdentity(fetch, journal.threads().length);
      const result = await archiveRequest(
        {
          ...identity,
          kind: 'kingdom',
          projectId: 'discovery',
          keepIds: [],
          credential: { type: 'kingdom-runtime' },
        },
        'remote/connections',
        { kastleId: identity.kastleId },
        fetch,
        credentials,
      );
      return c.json({ ...identity, connections: result.data });
    } catch {
      return c.json({ error: 'Connect Foundry to Kingdom in Settings → Kingdom first.' }, 503);
    }
  });
  app.get('/api/archives/connections', async (c) =>
    c.json({
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
                  : { kastleId: destination.kastleId }),
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
        kastleId: z.uuid().optional(),
        connectionId: z.string().nullable().optional(),
        query: z.string().max(1000).default(''),
      })
      .safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'Invalid Archive context request' }, 400);
    const matches = destinations.filter(
      (d) =>
        d.projectId === parsed.data.projectId &&
        d.url === parsed.data.url &&
        (!parsed.data.kastleId || (d.kind !== 'archive' && d.kastleId === parsed.data.kastleId)) &&
        (parsed.data.connectionId === undefined ||
          (d.kind === 'archive' ? null : (d.connectionId ?? null)) === parsed.data.connectionId),
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
          kastleId: destination.kind === 'archive' ? undefined : destination.kastleId,
          tokenEnv: destination.tokenEnv,
          credential: destination.credential,
          connectionId: destination.kind === 'archive' ? undefined : destination.connectionId,
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
    let created: CredentialReference | undefined;
    let committed = false;
    try {
      const input = await c.req.json();
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid connection');
      const { secret, ...configuration } = input;
      if (secret !== undefined) {
        if (configuration.credential || configuration.tokenEnv) throw Error('Choose one credential');
        // Validate the destination before accepting secret custody.
        const candidate = archiveDestinationSchema.parse({
          ...configuration,
          credential: { type: 'managed', id: crypto.randomUUID() },
        });
        if (candidate.kind !== 'archive') throw Error('Pair Kingdom to use native credentials');
        created = await credentials.save(
          { service: 'archive', url: candidate.url, projectId: candidate.projectId },
          z.string().min(1).max(16384).parse(secret),
        );
        configuration.credential = created;
      }
      const destination = archiveDestinationSchema.parse(configuration);
      await verifyArchiveDestination(destination, credentials);
      const configured = connectDestination(configPath, destination);
      committed = true;
      destinations = z.array(archiveDestinationSchema).parse(JSON.parse(readFileSync(configPath, 'utf8')));
      for (const archive of store.list())
        if (archive.projectId === destination.projectId) void publish(archive.id);
      return c.json({ ...configured, status: 'connected' });
    } catch {
      if (created && !committed) await credentials.remove(created).catch(() => {});
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
